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
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"html/template"
	"log/slog"
	mrand "math/rand/v2"
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

const loginSessionCookieName = "session"

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
	loginURL := os.Getenv("LOGIN_URL")

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

	user, err := newUserHandler(os.Getenv("USER_FILE"))
	if err != nil {
		return err
	}

	tmpl, err := template.ParseFS(templateFiles, "*.html")
	if err != nil {
		return fmt.Errorf("parse templates: %w", err)
	}

	sess := sessions{m: map[string]sessionEntry{}}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /register", func(w http.ResponseWriter, r *http.Request) {
		u := user.get()

		opts := []webauthn.RegistrationOption{
			webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired),
			webauthn.WithExclusions(webauthn.Credentials(u.WebAuthnCredentials()).CredentialDescriptors()),
			webauthn.WithExtensions(map[string]any{"credProps": true}),
		}

		creation, session, err := wa.BeginRegistration(u, opts...)
		if err != nil {
			slog.Error("begin registration", "err", err)
			respond(w, http.StatusInternalServerError)
			return
		}

		sessionID := sess.save(session)

		var resp struct {
			SessionID    string
			RegisterAddr string
			PublicKey    template.JS
		}

		resp.SessionID = sessionID
		resp.RegisterAddr = registerAddr
		resp.PublicKey = marshalProtocol(creation.Response)

		if err := tmpl.ExecuteTemplate(w, "register", resp); err != nil {
			slog.Error("failed to execute register template", "err", err, "session", sessionID)
			sess.delete(sessionID)
			return
		}
	})

	registerSrv := newServer(registerAddr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			respond(w, http.StatusMethodNotAllowed)
			return
		}

		sessionID := r.URL.Query().Get("session")

		session := sess.get(sessionID)
		if session == nil {
			slog.Info("not found", "session", sessionID)
			http.NotFound(w, r)
			return
		}
		defer sess.delete(sessionID)

		credential, err := wa.FinishRegistration(user.get(), *session, r)
		if err != nil {
			slog.Error("finish registration", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		if err := user.update(*credential); err != nil {
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
			LoginURL    string
			PublicKey   template.JS
		}

		resp.SessionID = sess.save(session)
		resp.PublicKey = marshalProtocol(assertion.Response)
		resp.LoginURL = loginURL

		resp.RedirectURL = r.Header.Get("X-Redirect-Url")
		if resp.RedirectURL == "" {
			resp.RedirectURL = "/"
		}

		if err := tmpl.ExecuteTemplate(w, "login", resp); err != nil {
			sess.delete(resp.SessionID)
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
		defer sess.delete(sessionID)

		_, cred, err := wa.FinishPasskeyLogin(user.load, *session, r)
		if err != nil {
			slog.Error("finish login", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		if err := user.update(*cred); err != nil {
			slog.Error("update user", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		age := time.Hour * 24 * 365

		payload, err := loginSession{Exp: time.Now().Add(age)}.Encode(secretKey)
		if err != nil {
			slog.Error("encode payload", "err", err, "session", sessionID)
			respond(w, http.StatusInternalServerError)
			return
		}

		http.SetCookie(w, &http.Cookie{
			Name:     loginSessionCookieName,
			Value:    payload,
			Path:     "/",
			MaxAge:   int(age),
			Secure:   true,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})

		w.WriteHeader(http.StatusOK)
	})

	mux.HandleFunc("/{$}", func(w http.ResponseWriter, r *http.Request) {
		c, _ := r.Cookie(loginSessionCookieName)
		if c == nil {
			respond(w, http.StatusUnauthorized)
			return
		}

		l, err := decodeLoginSession(c.Value, secretKey)
		if err != nil {
			respond(w, http.StatusUnauthorized)
			return
		}

		if time.Now().After(l.Exp) {
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

type userHandler struct {
	user webAuthnUser
	mu   sync.Mutex
	file string
}

func newUserHandler(file string) (*userHandler, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, fmt.Errorf("read user file: %w", err)
	}

	var userData webAuthnUserData

	if err := json.Unmarshal(data, &userData); err != nil {
		return nil, fmt.Errorf("parse user data: %w", err)
	}

	id, err := hex.DecodeString(userData.ID)
	if err != nil {
		return nil, fmt.Errorf("parse user ID: %w", err)
	}

	if want, got := 64, len(id); want != got {
		return nil, fmt.Errorf("expected %d bytes ID, got %d", want, got)
	}

	return &userHandler{
		user: webAuthnUser{ID: id, Name: userData.Name, Credentials: userData.Credentials},
		file: file,
	}, nil
}

func (u *userHandler) get() webauthn.User {
	u.mu.Lock()
	user := u.user
	u.mu.Unlock()
	return user
}

func (u *userHandler) load(_, _ []byte) (webauthn.User, error) {
	return u.get(), nil
}

func (u *userHandler) update(cred webauthn.Credential) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	creds := slices.Clone(u.user.Credentials)

	i := slices.IndexFunc(creds, func(c webauthn.Credential) bool {
		return bytes.Equal(c.ID, cred.ID)
	})
	if i >= 0 {
		creds[i] = cred
	} else {
		creds = append(creds, cred)
	}

	data, err := json.Marshal(webAuthnUserData{
		ID:          hex.EncodeToString(u.user.ID),
		Name:        u.user.Name,
		Credentials: creds,
	}, jsontext.WithIndent("  "))
	if err != nil {
		return fmt.Errorf("marshal user: %w", err)
	}

	if err := os.WriteFile(u.file, data, 0o600); err != nil {
		return fmt.Errorf("write user file: %w", err)
	}

	u.user.Credentials = creds

	return nil
}

//go:embed *.html
var templateFiles embed.FS

type sessions struct {
	mu sync.Mutex
	m  map[string]sessionEntry
}

type sessionEntry struct {
	data *webauthn.SessionData
	exp  *time.Timer
}

func (s *sessions) save(session *webauthn.SessionData) string {
	var raw [16]byte
	rand.Read(raw[:])

	id := hex.EncodeToString(raw[:])

	s.mu.Lock()
	s.m[id] = sessionEntry{
		data: session,
		exp:  time.AfterFunc(time.Until(session.Expires), func() { s.delete(id) }),
	}
	s.mu.Unlock()

	return id
}

func (s *sessions) get(id string) *webauthn.SessionData {
	s.mu.Lock()
	session, ok := s.m[id]
	s.mu.Unlock()

	if ok {
		return session.data
	}
	return nil
}

func (s *sessions) delete(id string) {
	s.mu.Lock()
	if sess, ok := s.m[id]; ok {
		sess.exp.Stop()
		delete(s.m, id)
	}
	s.mu.Unlock()
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
	Exp time.Time `json:"exp"`
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
	if err := json.Unmarshal(data, &l); err != nil {
		return loginSession{}, fmt.Errorf("malformed input: %w", err)
	}

	return l, nil
}

func (l loginSession) Encode(secretKey []byte) (string, error) {
	data, err := json.Marshal(l)
	if err != nil {
		return "", err
	}

	h := hmac.New(sha256.New, secretKey)
	h.Write(data)

	enc := base64.URLEncoding

	return enc.EncodeToString(data) + "." + enc.EncodeToString(h.Sum(nil)), nil
}

func respond(w http.ResponseWriter, code int) {
	http.Error(w, http.StatusText(code), code)
}

func marshalProtocol(v any) template.JS {
	marker := fmt.Sprintf("%%%x%%", mrand.Uint64())
	enc := json.MarshalFunc(func(p protocol.URLEncodedBase64) ([]byte, error) {
		x := make([]int, len(p))
		for i := range p {
			x[i] = int(p[i])
		}
		v, err := json.Marshal(x)
		return slices.Concat([]byte(`"`+marker), v, []byte(marker+`"`)), err
	})
	b, _ := json.Marshal(v, json.WithMarshalers(enc))
	return template.JS(strings.NewReplacer(
		fmt.Sprintf("\"%s[", marker), "new Uint8Array([",
		fmt.Sprintf("]%s\"", marker), "])",
	).Replace(string(b)))
}
