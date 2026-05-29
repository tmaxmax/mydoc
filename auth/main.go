package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"embed"
	_ "embed"
	"encoding/base64"
	"encoding/gob"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

func main() {
	if err := run(); err != nil {
		slog.Error("run", "err", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	origin, err := url.ParseRequestURI(os.Getenv("RP_ORIGIN"))
	if err != nil {
		return fmt.Errorf("parse RP origin: %w", err)
	}

	secretKey, err := hex.DecodeString(os.Getenv("HMAC_SECRET"))
	if err != nil || len(secretKey) < 32 {
		return errors.New("malformed secret key")
	}

	registerAddr := os.Getenv("REGISTER_ADDR")

	timeouts := webauthn.TimeoutConfig{
		Enforce:    true,
		Timeout:    5 * time.Minute,
		TimeoutUVD: 5 * time.Minute,
	}

	wa, err := webauthn.New(&webauthn.Config{
		RPDisplayName: "Archive Qua Teo",
		RPID:          origin.Hostname(),
		RPOrigins:     []string{origin.String()},
		Timeouts: webauthn.TimeoutsConfig{
			Registration: timeouts,
			Login:        timeouts,
		},
	})
	if err != nil {
		return fmt.Errorf("create Webauthn: %w", err)
	}

	userFile := os.Getenv("USER_FILE")
	userMu := sync.Mutex{}

	user, err := readUserData(userFile)
	if err != nil {
		return err
	}

	loadUser := func(_, _ []byte) (webauthn.User, error) {
		userMu.Lock()
		defer userMu.Unlock()
		return user, nil
	}

	updateUser := func(cred webauthn.Credential) error {
		userMu.Lock()
		defer userMu.Unlock()

		i := slices.IndexFunc(user.Credentials, func(c webauthn.Credential) bool {
			return bytes.Equal(c.ID, cred.ID)
		})
		if i >= 0 {
			user.Credentials[i] = cred
		} else {
			user.Credentials = append(user.Credentials, cred)
		}

		data, err := json.MarshalIndent(webAuthnUserData{
			ID:          user.IDString(),
			Name:        user.Name,
			Credentials: user.Credentials,
		}, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal user: %w", err)
		}

		if err := os.WriteFile(userFile, data, 0o666); err != nil {
			return fmt.Errorf("write user file: %w", err)
		}

		return nil
	}

	tmpl, err := template.ParseFS(templateFiles, "*.html")
	if err != nil {
		return fmt.Errorf("parse templates: %w", err)
	}

	sess := sessions{m: map[string]*webauthn.SessionData{}}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /register", func(w http.ResponseWriter, r *http.Request) {
		opts := []webauthn.RegistrationOption{
			webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
			webauthn.WithExclusions(webauthn.Credentials(user.WebAuthnCredentials()).CredentialDescriptors()),
			webauthn.WithExtensions(map[string]any{"credProps": true}),
		}

		creation, session, err := wa.BeginRegistration(user, opts...)
		if err != nil {
			slog.Error("begin registration", "err", err)
			respond(w, http.StatusInternalServerError)
			return
		}

		slog.Info("session", "exp", session.Expires)

		var resp struct {
			SessionID    string
			RegisterAddr string
			PublicKey    protocol.PublicKeyCredentialCreationOptions
		}

		resp.SessionID = sess.save(session)
		resp.RegisterAddr = registerAddr
		resp.PublicKey = creation.Response

		if err := tmpl.ExecuteTemplate(w, "register", resp); err != nil {
			slog.Error("failed to execute register template", "err", err, "session", sessionID)
			return
		}
	})

	registerSrv := newServer(registerAddr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.URL.Query().Get("session")

		session := sess.get(sessionID)
		if session == nil {
			slog.Info("not found", "session", sessionID)
			http.NotFound(w, r)
			return
		}

		credential, err := wa.FinishRegistration(user, *session, r)
		if err != nil {
			slog.Error("finish registration", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		if err := updateUser(*credential); err != nil {
			slog.Error("update user", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		respond(w, http.StatusOK)
	}))

	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) {
		assertion, session, err := wa.BeginDiscoverableLogin()
		if err != nil {
			slog.Error("begin login", "err", err)
			respond(w, http.StatusInternalServerError)
			return
		}

		var resp struct {
			SessionID   string
			RedirectURL string
			PublicKey   protocol.PublicKeyCredentialRequestOptions
		}

		resp.SessionID = sess.save(session)
		resp.PublicKey = assertion.Response

		resp.RedirectURL = r.Header.Get("X-Redirect-Url")
		if resp.RedirectURL == "" {
			resp.RedirectURL = "/"
		}

		if err := tmpl.ExecuteTemplate(w, "login", resp); err != nil {
			slog.Error("failed to execute register template", "err", err)
			return
		}
	})

	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.Header.Get("X-Session-Id")

		session := sess.get(sessionID)
		if session == nil {
			http.NotFound(w, r)
			return
		}

		_, cred, err := wa.FinishPasskeyLogin(loadUser, *session, r)
		if err != nil {
			slog.Error("finish login", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		if err := updateUser(*cred); err != nil {
			slog.Error("update user", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		age := time.Hour * 24 * 365

		payload, err := loginSession{ID: sessionID, Exp: time.Now().Add(age)}.Encode(secretKey)
		if err != nil {
			slog.Error("encode payload", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		http.SetCookie(w, &http.Cookie{
			Name:     "session",
			Value:    payload,
			MaxAge:   int(age),
			Secure:   true,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})

		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie("session")
		if c == nil {
			slog.Info("missing cookie")
			respond(w, http.StatusUnauthorized)
			return
		}

		l, err := decodeLoginSession(c.Value, secretKey)
		if err != nil {
			slog.Info("decode login session", "err", err)
			respond(w, http.StatusUnauthorized)
			return
		}

		if time.Now().After(l.Exp) {
			slog.Info("session expired", "session", l.ID)
			respond(w, http.StatusUnauthorized)
			return
		}

		respond(w, http.StatusOK)
	})

	srv := newServer(os.Getenv("ADDR"), mux)
	errSrv, errReg := make(chan error, 1), make(chan error, 1)

	defer srv.Close()
	defer registerSrv.Close()

	go func() {
		errSrv <- srv.ListenAndServe()
	}()
	go func() {
		errReg <- registerSrv.ListenAndServe()
	}()

	slog.Info("servers open", "main", origin.Scheme+"://"+srv.Addr, "register", origin.Scheme+"://"+registerSrv.Addr)

	select {
	case err := <-errSrv:
		return fmt.Errorf("start server: %w", err)
	case err := <-errReg:
		return fmt.Errorf("start register server: %w", err)
	case <-ctx.Done():
		sctx, cancel := context.WithTimeout(context.Background(), time.Second*10)
		defer cancel()

		return errors.Join(srv.Shutdown(sctx), registerSrv.Shutdown(sctx))
	}
}

type webAuthnUserData struct {
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Credentials []webauthn.Credential `json:"credentials"`
}

type webAuthnUser struct {
	ID          []byte
	Name        string
	Credentials []webauthn.Credential
}

func (u webAuthnUser) WebAuthnID() []byte                         { return u.ID }
func (u webAuthnUser) WebAuthnName() string                       { return u.Name }
func (u webAuthnUser) WebAuthnDisplayName() string                { return u.Name }
func (u webAuthnUser) WebAuthnCredentials() []webauthn.Credential { return u.Credentials }

func (u webAuthnUser) IDString() string { return hex.EncodeToString(u.ID) }

func readUserData(file string) (webAuthnUser, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return webAuthnUser{}, fmt.Errorf("read user file: %w", err)
	}

	var userData webAuthnUserData

	if err := json.Unmarshal(data, &userData); err != nil {
		return webAuthnUser{}, fmt.Errorf("parse user data: %w", err)
	}

	id, err := hex.DecodeString(userData.ID)
	if err != nil {
		return webAuthnUser{}, fmt.Errorf("parse user ID: %w", err)
	}

	if want, got := 64, len(id); want != got {
		return webAuthnUser{}, fmt.Errorf("expected %d bytes ID, got %d", want, got)
	}

	return webAuthnUser{ID: id, Name: userData.Name, Credentials: userData.Credentials}, nil
}

//go:embed *.html
var templateFiles embed.FS

func sessionID() string {
	var raw [16]byte
	rand.Read(raw[:])

	return hex.EncodeToString(raw[:])
}

type sessions struct {
	mu sync.Mutex
	m  map[string]*webauthn.SessionData
}

func (s *sessions) save(session *webauthn.SessionData) string {
	id := sessionID()

	s.mu.Lock()
	s.m[id] = session
	s.mu.Unlock()

	time.AfterFunc(time.Until(session.Expires), func() {
		s.mu.Lock()
		delete(s.m, id)
		s.mu.Unlock()
	})

	return id
}

func (s *sessions) get(id string) *webauthn.SessionData {
	s.mu.Lock()
	session := s.m[id]
	s.mu.Unlock()

	return session
}

func newServer(addr string, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadTimeout:       5 * time.Second,
		ReadHeaderTimeout: 2 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
}

type loginSession struct {
	ID  string
	Exp time.Time
}

func decodeLoginSession(payload string, secretKey []byte) (loginSession, error) {
	dataEnc, signEnc, ok := strings.Cut(payload, ".")
	if !ok {
		return loginSession{}, errors.New("malformed payload")
	}

	enc := base64.URLEncoding

	sign, serr := enc.DecodeString(signEnc)
	data, derr := enc.DecodeString(dataEnc)
	if err := errors.Join(serr, derr); err != nil {
		return loginSession{}, fmt.Errorf("malformed input: %w", err)
	}

	h := hmac.New(sha256.New, secretKey)
	h.Write(data)

	if !hmac.Equal(sign, h.Sum(nil)) {
		return loginSession{}, errors.New("invalid input")
	}

	var l loginSession
	if err := gob.NewDecoder(bytes.NewReader(data)).Decode(&l); err != nil {
		return loginSession{}, fmt.Errorf("malformed input: %w", err)
	}

	return l, nil
}

func (l loginSession) Encode(secretKey []byte) (string, error) {
	b, h := &bytes.Buffer{}, hmac.New(sha256.New, secretKey)
	if err := gob.NewEncoder(io.MultiWriter(b, h)).Encode(l); err != nil {
		return "", err
	}

	enc := base64.URLEncoding

	return enc.EncodeToString(b.Bytes()) + "." + enc.EncodeToString(h.Sum(nil)), nil
}

func respond(w http.ResponseWriter, code int) {
	http.Error(w, http.StatusText(code), code)
}
