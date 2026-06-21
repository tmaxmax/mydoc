package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"iter"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "ERROR: %v\n", err)
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

	inDir, err := filepath.Abs(inDir)
	if err != nil {
		return fmt.Errorf("get absolute input path: %w", err)
	}

	filesInDirs := map[string][]string{}
	hasIndex := func(dir string) bool {
		return slices.ContainsFunc(filesInDirs[dir], func(p string) bool {
			return path.Base(p) == indexFile
		})
	}
	dirs := map[string][]string{}

	if err := filepath.WalkDir(inDir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		p = filepath.ToSlash(strings.TrimPrefix(p, inDir))
		dir := path.Dir(p)

		if strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
		} else if d.IsDir() {
			dirs[dir] = append(dirs[dir], p)
		} else if p != "" {
			filesInDirs[dir] = append(filesInDirs[dir], p)
		}

		return nil
	}); err != nil {
		return fmt.Errorf("read input dir: %w", err)
	}

	tree, err := buildTree("/", dirs, filesInDirs, inDir)
	if err != nil {
		return fmt.Errorf("build index tree: %w", err)
	}

	trees := map[string]Tree{}
	for t := range tree.Walk() {
		depth := 1
		if t.Dir == "/" {
			depth = 5
		}
		if t.Href != "" {
			e := t.Extract(depth)
			e.Children = slices.DeleteFunc(e.Children, func(c Child) bool {
				a, ok := c.(Article)
				return ok && a.Index
			})
			trees[t.Dir] = e
		}
	}

	var changed []Change

	if full {
		fmt.Fprintln(os.Stderr, "FULL BUILD")

		changed = changed[:0]
		for _, files := range filesInDirs {
			for _, file := range files {
				changed = append(changed, Change{
					Path:   strings.TrimPrefix(file, "/"),
					Status: StatusModified,
				})
			}
		}

		assetsDir := filepath.Join(outDir, ".assets")

		fmt.Fprintln(os.Stderr, "Clear output dir...")
		if err := os.RemoveAll(outDir); err != nil {
			return fmt.Errorf("reset output: %w", err)
		}
		if err := os.MkdirAll(assetsDir, 0o755); err != nil {
			return fmt.Errorf("create assets dir: %w", err)
		}

		fmt.Fprintln(os.Stderr, "Patch KaTeX fonts...")
		if err := patchKatexFonts(ctx); err != nil {
			return fmt.Errorf("patch KaTeX: %w", err)
		}

		fmt.Fprintln(os.Stderr, "Copy build static assets...")
		if err := copyDir("static", assetsDir); err != nil {
			return fmt.Errorf("copy fonts: %w", err)
		}

		fmt.Fprintln(os.Stderr, "Copy KaTeX assets...")
		if err := copyKatexFonts(assetsDir); err != nil {
			return fmt.Errorf("copy KaTeX fonts: %w", err)
		}
	} else {
		fmt.Fprintln(os.Stderr, "DIFF BUILD")

		seen := map[string]struct{}{}

		var toRebuild []string
		if hasIndex("/") {
			toRebuild = append(toRebuild, indexFile)
		}

		for change := range changes(os.Stdin, &err) {
			if hasDot(change.Path) {
				continue
			}

			if dir := path.Dir("/" + change.Path); hasIndex(dir) {
				toRebuild = append(toRebuild, path.Join(dir, indexFile))
			}

			seen[change.Path] = struct{}{}
			changed = append(changed, change)
		}
		if err != nil {
			return fmt.Errorf("read input: %w", err)
		}

		for _, p := range toRebuild {
			if _, ok := seen[p]; !ok {
				changed = append(changed, Change{
					Status: StatusModified,
					Path:   p,
				})
			}
		}

		if slices.ContainsFunc(changed, func(c Change) bool { return path.Ext(c.Path) == ".md" }) && os.Getenv("DEV") == "" {
			fmt.Fprintln(os.Stderr, "Patch KaTeX fonts...")
			if err := patchKatexFonts(ctx); err != nil {
				return fmt.Errorf("patch KaTeX: %w", err)
			}
		}
	}

	for _, change := range changed {
		inPath := filepath.Join(inDir, filepath.FromSlash(change.Path))

		modify, outPath := os.Link, ""
		if ext := path.Ext(change.Path); ext == ".md" {
			if isIndex := path.Base(change.Path) == indexFile; !isIndex || change.Path != indexFile {
				outPath = filepath.Join(outDir, filepath.FromSlash(strings.TrimSuffix(change.Path, ext)+".html"))

				meta := pandocMetadata{IndexHref: "/#tree-" + slugFromPath(change.Path)}
				if isIndex {
					meta.Tree = new(trees[path.Dir("/"+change.Path)])
				}

				modify = func(in, out string) error { return pandoc(ctx, meta, in, out) }
			} else {
				outPath = outDir
				modify = buildIndex(ctx, trees["/"])
			}
		} else {
			outPath = filepath.Join(outDir, filepath.FromSlash(change.Path))
		}

		fmt.Fprintf(os.Stderr, "Handle %s %s...\n", change.Status, change.Path)

		switch change.Status {
		case StatusAdded, StatusModified:
			if err = os.MkdirAll(filepath.Dir(outPath), 0o755); err == nil {
				err = modify(inPath, outPath)
			}
		case StatusDeleted:
			err = os.Remove(outPath)
		}

		if err != nil {
			return fmt.Errorf("Handle %s change for %q: %w", change.Status, change.Path, err)
		}
	}

	fmt.Fprintln(os.Stderr, "SUCCESS")

	return nil
}

func hasDot(p string) bool {
	if p == "." {
		return false
	}
	for c := range strings.SplitSeq(p, "/") {
		if strings.HasPrefix(c, ".") {
			return true
		}
	}
	return false
}

const indexFile = "index.md"

type Status string

const (
	StatusAdded    Status = "A"
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
			case 'A':
				c = Change{
					Status: StatusAdded,
					Path:   path,
				}
			case 'C', 'M', 'T':
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

type pandocMetadata struct {
	Tree      *Tree
	IndexHref string
	Message   string
}

func pandoc(ctx context.Context, meta pandocMetadata, inPath, outPath string) error {
	f, err := os.CreateTemp("", "pandoc-meta-*.json")
	if err != nil {
		return fmt.Errorf("create metadata file: %w", err)
	}
	defer os.Remove(f.Name())
	defer f.Close()

	if err := errors.Join(json.NewEncoder(f).Encode(meta), f.Close()); err != nil {
		return fmt.Errorf("write metadata: %w", err)
	}

	cmd := exec.CommandContext(ctx, "pandoc",
		"-d", filepath.Join("defaults", "archive.yml"),
		"--metadata-file", f.Name(),
		inPath,
		"-o", outPath,
	)
	cmd.Stderr = os.Stderr

	return cmd.Run()
}

func patchKatexFonts(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, "python3", "patch_katex_fonts.py")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("patch: %w\n%s", err, string(out))
	}
	return nil
}

func copyKatexFonts(outDir string) error {
	fonts, err := filepath.Glob(filepath.Join("node_modules", "katex", "dist", "fonts", "*"))
	if err != nil {
		return fmt.Errorf("read unpatched: %w", err)
	}

	patchedFonts, err := filepath.Glob(filepath.Join("out", "*"))
	if err != nil {
		return fmt.Errorf("read patched: %w", err)
	}

	fonts = slices.DeleteFunc(fonts, func(font string) bool {
		return slices.ContainsFunc(patchedFonts, func(patched string) bool {
			return filepath.Base(font) == filepath.Base(patched)
		})
	})

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

func buildIndex(ctx context.Context, tree Tree) func(oldPath, outDir string) error {
	publicTree := tree
	if tree.Dir == "/" {
		publicTree.Children = slices.Clone(tree.Children)
		i := slices.IndexFunc(publicTree.Children, func(c Child) bool {
			t, ok := c.(Tree)
			return ok && t.Name == "me"
		})
		if i >= 0 {
			t := publicTree.Children[i].(Tree)
			t.Children = []Child{Article{
				Title:       "login",
				Description: "Are you me? Then login.",
				Href:        "/auth/login",
			}}
			publicTree.Children = append(slices.Delete(publicTree.Children, i, i+1), t)
		}
	}

	return func(oldPath, outDir string) error {
		if err := pandoc(ctx, pandocMetadata{Tree: new(publicTree)}, oldPath, filepath.Join(outDir, "index.html")); err != nil {
			return fmt.Errorf("build public index: %w", err)
		}
		if err := pandoc(ctx, pandocMetadata{Tree: new(tree)}, oldPath, filepath.Join(outDir, ".private.index.html")); err != nil {
			return fmt.Errorf("build private index: %w", err)
		}

		meta := pandocMetadata{
			Message: "The path you seek has never been or is no more.\n\nMay you find back your way.",
			Tree:    new(publicTree),
		}
		if err := pandoc(ctx, meta, oldPath, filepath.Join(outDir, ".404.index.html")); err != nil {
			return fmt.Errorf("build 404: %w", err)
		}

		return nil
	}
}
