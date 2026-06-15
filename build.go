package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"

	"github.com/goccy/go-yaml"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()

	var inDir, outDir string
	var full bool

	f := flag.NewFlagSet("mydoc", flag.ContinueOnError)
	f.StringVar(&inDir, "in", "", "Input directory. All changes are resolved relative to this directory.")
	f.StringVar(&outDir, "out", "", "Output directory.")
	f.BoolVar(&full, "full", false, "Trigger a full build.")

	if err := f.Parse(os.Args[1:]); err != nil {
		return fmt.Errorf("parse CLI: %w", err)
	}

	inDir = filepath.Clean(inDir)

	paths := map[string][]string{}
	if err := filepath.WalkDir(inDir, func(path string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() && !strings.HasPrefix(path, ".") {
			dir := filepath.Dir(path)
			paths[dir] = append(paths[dir], path)
		}
		return err
	}); err != nil {
		return fmt.Errorf("read input dir: %w", err)
	}

	var changed []Change

	err := patchKatexFonts(ctx)
	if err != nil {
		return fmt.Errorf("patch KaTeX: %w", err)
	}

	if full {
		changed = changed[:0]
		for _, files := range paths {
			for _, file := range files {
				changed = append(changed, Change{
					Path:   strings.TrimPrefix(file, inDir+string(filepath.Separator)),
					Status: StatusModified,
				})
			}
		}

		assetsDir := filepath.Join(outDir, ".assets")

		if err := os.RemoveAll(outDir); err != nil {
			return fmt.Errorf("reset output: %w", err)
		}
		if err := os.MkdirAll(assetsDir, 0o755); err != nil {
			return fmt.Errorf("create assets dir: %w", err)
		}
		if err := copyDir(filepath.Join(buildDir(), "static"), assetsDir); err != nil {
			return fmt.Errorf("copy fonts: %w", err)
		}
		if err := copyDir(filepath.Join(inDir, ".assets"), assetsDir); err != nil {
			return fmt.Errorf("copy fonts: %w", err)
		}
		if err := copyKatexFonts(assetsDir); err != nil {
			return fmt.Errorf("copy KaTeX fonts: %w", err)
		}
	} else {
		for change := range changes(os.Stdin, &err) {
			if !strings.HasPrefix(change.Path, ".") {
				changed = append(changed, change)
			}
		}
		if err != nil {
			return fmt.Errorf("read input: %w", err)
		}
	}

	for _, change := range changed {
		inPath := filepath.Join(inDir, change.Path)

		modify, outPath := os.Link, ""
		if ext := filepath.Ext(change.Path); ext == ".md" {
			outPath = filepath.Join(outDir, strings.TrimSuffix(change.Path, ext)+".html")
			modify = func(in, out string) error { return pandoc(ctx, in, out) }
		} else {
			outPath = filepath.Join(outDir, change.Path)
		}

		switch change.Status {
		case StatusModified:
			err = modify(inPath, outPath)
		case StatusDeleted:
			err = os.Remove(outPath)
		}

		if err != nil {
			return fmt.Errorf("handle %s change for %q: %w", change.Status, change.Path, err)
		}
	}

	return nil
}

type Status string

const (
	StatusModified Status = "M"
	StatusDeleted  Status = "D"
)

type Change struct {
	Path   string
	Status Status
}

func changes(r io.Reader, errp *error) iter.Seq[Change] {
	return func(yield func(Change) bool) {
		next, stop := iter.Pull(nullStream(bufio.NewReader(r), errp))
		defer stop()

		for {
			status, sok := next()
			path, pok := next()
			if !sok || !pok {
				return
			}

			var c Change

			switch status[0] {
			case 'A', 'C', 'M', 'T':
				c = Change{
					Status: StatusModified,
					Path:   path,
				}
			case 'D':
				c = Change{
					Status: StatusDeleted,
					Path:   path,
				}
			case 'R':
				to, ok := next()
				if !ok {
					*errp = errors.New("missing rename path")
					return
				}

				if !yield(Change{
					Status: StatusDeleted,
					Path:   path,
				}) {
					return
				}
				c = Change{
					Status: StatusModified,
					Path:   to,
				}
			default:
				*errp = fmt.Errorf("unknown status %q", status)
				return
			}

			if !yield(c) {
				return
			}
		}
	}
}

func nullStream(r *bufio.Reader, errp *error) iter.Seq[string] {
	return func(yield func(string) bool) {
		for {
			in, err := r.ReadString('\x00')
			if err != nil {
				if !errors.Is(err, io.EOF) {
					*errp = err
				}
				return
			} else if !yield(strings.TrimSuffix(in, "\x00")) {
				return
			}
		}
	}
}

type Metadata struct {
	TitlePrefix string `yaml:"title-prefix"`
	PageTitle   string `yaml:"page-title"`
	Description string `yaml:"description-meta"`
}

func metadata(inPath string) (Metadata, error) {
	f, err := os.Open(inPath)
	if err != nil {
		return Metadata{}, err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	if !sc.Scan() || sc.Text() != "---" {
		return Metadata{}, sc.Err()
	}

	var buf bytes.Buffer
	for sc.Scan() && !isMetadataEnd(sc.Text()) {
		buf.Write(sc.Bytes())
		buf.WriteByte('\n')
	}

	if !isMetadataEnd(sc.Text()) {
		return Metadata{}, sc.Err()
	}

	var meta Metadata
	if err := yaml.Unmarshal(buf.Bytes(), &meta); err != nil {
		return Metadata{}, err
	}

	return meta, nil
}

func isMetadataEnd(s string) bool {
	return s == "---" || s == "..."
}

var buildDir = sync.OnceValue(func() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Dir(file)
})

func pandoc(ctx context.Context, inPath, outPath string) error {
	cmd := exec.CommandContext(ctx, "pandoc", "-d", filepath.Join("defaults", "archive.yml"), inPath, "-o", outPath)
	cmd.Dir = buildDir()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("%w\n%s", err, string(out))
	}
	return nil
}

func patchKatexFonts(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "python3", "patch_katex_fonts.py")
	cmd.Dir = buildDir()
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("patch: %w\n%s", err, string(out))
	}
	return nil
}

func copyKatexFonts(outDir string) error {
	fonts, err := filepath.Glob(filepath.Join(buildDir(), "node_modules", "katex", "dist", "fonts", "*"))
	if err != nil {
		return fmt.Errorf("read unpatched: %w", err)
	}

	patchedFonts, err := filepath.Glob(filepath.Join(buildDir(), "out", "*"))
	if err != nil {
		return fmt.Errorf("read patched: %w", err)
	}

	for _, font := range append(fonts, patchedFonts...) {
		if ext := filepath.Ext(font); ext != ".woff2" && ext != ".css" {
			continue
		}
		if err := os.Link(font, filepath.Join(outDir, filepath.Base(font))); err != nil {
			return fmt.Errorf("link font: %w", err)
		}
	}

	return nil
}

func copyDir(inDir, outDir string) error {
	dir, err := os.OpenRoot(inDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("open static: %w", err)
	}

	return os.CopyFS(outDir, dir.FS())
}
