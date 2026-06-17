package main

import (
	"bufio"
	"bytes"
	"cmp"
	"errors"
	"fmt"
	"iter"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/goccy/go-yaml"
)

type Tree struct {
	Name          string
	Href          string
	Dir           string `json:"-"`
	LastPublished DateMeta
	Articles      []Article
	Children      []Tree
}

func (t Tree) Compare(u Tree) int {
	return cmp.Or(
		u.LastPublished.Compare(t.LastPublished),
		strings.Compare(t.Name, u.Name),
	)
}

func (t Tree) Clone(depth int) Tree {
	c := Tree{
		Name:          t.Name,
		Href:          t.Href,
		Dir:           t.Dir,
		LastPublished: t.LastPublished,
		Articles:      slices.Clone(t.Articles),
	}
	if depth > 0 {
		for _, child := range t.Children {
			c.Children = append(c.Children, child.Clone(depth-1))
		}
	}
	return c
}

func (t Tree) Walk() iter.Seq[Tree] {
	return func(yield func(Tree) bool) {
		t.walk(yield)
	}
}

func (t Tree) walk(yield func(Tree) bool) bool {
	if !yield(t) {
		return false
	}
	for _, c := range t.Children {
		if !c.walk(yield) {
			return false
		}
	}
	return true
}

type Article struct {
	Title       string
	Subtitle    string
	Date        DateMeta
	Description string
	Href        string
	Index       bool
}

func (a Article) Compare(b Article) int {
	return cmp.Or(
		cmpBool(b.Index, a.Index),
		b.Date.Compare(a.Date),
		strings.Compare(a.Title, b.Title),
		strings.Compare(a.Subtitle, b.Subtitle),
	)
}

func buildTree(entrypoint string, dirs, filesInDirs map[string][]string, inDir string) (Tree, error) {
	t := Tree{Name: path.Base(entrypoint), Dir: entrypoint, Href: entrypoint}

	var metas []Metadata
	var hrefs []string
	var iMeta = -1

	for _, p := range filesInDirs[entrypoint] {
		if path.Ext(p) != ".md" {
			continue
		}

		meta, err := metadata(filepath.Join(inDir, filepath.FromSlash(p)))
		if err != nil {
			return Tree{}, fmt.Errorf("read metadata for %q: %w", p, err)
		}

		metas = append(metas, meta)
		hrefs = append(hrefs, hrefFromPath(p))

		if path.Base(p) == indexFile {
			iMeta = len(metas) - 1
		}
	}

	if iMeta == -1 {
		t.Href = ""
	}

	for i, meta := range metas {
		a := Article{
			Date:        meta.Date,
			Description: meta.Description,
			Href:        hrefs[i],
			Index:       i == iMeta,
		}
		if a.Index || iMeta == -1 {
			a.Title = cmp.Or(meta.Title, meta.PageTitle)
			a.Subtitle = cmp.Or(meta.Subtitle, meta.TitlePrefix)
		} else {
			a.Title, a.Subtitle = pickTitleSubtitle(meta, metas[iMeta])
		}
		if a.Date.Compare(t.LastPublished) > 0 {
			t.LastPublished = a.Date
		}
		t.Articles = append(t.Articles, a)
	}

	for _, childDir := range dirs[entrypoint] {
		ct, err := buildTree(childDir, dirs, filesInDirs, inDir)
		if errors.Is(err, errNoArticles) {
			continue
		} else if err != nil {
			return Tree{}, fmt.Errorf("for %q: %w", childDir, err)
		}
		if ct.LastPublished.Compare(t.LastPublished) > 0 {
			t.LastPublished = ct.LastPublished
		}
		t.Children = append(t.Children, ct)
	}

	if len(t.Children) == 0 && len(t.Articles) == 0 {
		return Tree{}, errNoArticles
	}

	slices.SortStableFunc(t.Articles, Article.Compare)
	slices.SortStableFunc(t.Children, Tree.Compare)

	return t, nil
}

var errNoArticles = errors.New("no articles")

func hrefFromPath(p string) string {
	p = strings.TrimSuffix(p, indexFile)
	p = strings.TrimSuffix(p, ".md")
	if p != "/" {
		p = strings.TrimSuffix(p, "/")
	}
	return p
}

func pickTitleSubtitle(meta, index Metadata) (title, subtitle string) {
	title = cmp.Or(meta.Title, meta.PageTitle)
	subtitle = cmp.Or(meta.Subtitle, meta.TitlePrefix)
	if subtitle == "" {
		return
	}
	if meta.PageTitle == index.PageTitle || (meta.Title != "" && index.Title == meta.Title) {
		title = subtitle
		subtitle = ""
	}
	return
}

type Metadata struct {
	TitlePrefix string   `yaml:"title-prefix"`
	PageTitle   string   `yaml:"pagetitle"`
	Description string   `yaml:"description-meta"`
	Date        DateMeta `yaml:"date-meta"`
	Title       string   `yaml:"title"`
	Subtitle    string   `yaml:"subtitle"`
	Lang        string   `yaml:"lang"`
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
	if err := yaml.UnmarshalWithOptions(buf.Bytes(), &meta, yaml.UseJSONUnmarshaler()); err != nil {
		return Metadata{}, err
	}

	return meta, nil
}

func isMetadataEnd(s string) bool {
	return s == "---" || s == "..."
}

type DateMeta struct {
	Time  time.Time
	Parts int
}

func (d *DateMeta) UnmarshalJSON(b []byte) (err error) {
	s := strings.ReplaceAll(string(b), "\"", "")
	d.Parts = strings.Count(s, "-")
	switch d.Parts {
	case 0:
		if s == "null" || s == `""` {
			return
		}
		d.Time, err = time.Parse(time.DateOnly[:4], s)
	case 1:
		d.Time, err = time.Parse(time.DateOnly[:7], s)
	case 2:
		d.Time, err = time.Parse(time.DateOnly, s)
	default:
		return fmt.Errorf("got %d date parts", d.Parts)
	}
	return
}

func (d DateMeta) MarshalJSON() ([]byte, error) {
	if d.Time.IsZero() {
		return []byte(`""`), nil
	}
	buf := []byte{'"'}
	switch d.Parts {
	case 0:
		buf = d.Time.AppendFormat(buf, time.DateOnly[:4])
	case 1:
		buf = d.Time.AppendFormat(buf, time.DateOnly[:7])
	case 2:
		buf = d.Time.AppendFormat(buf, time.DateOnly)
	default:
		return nil, fmt.Errorf("got %d date parts", d.Parts)
	}
	return append(buf, '"'), nil
}

func (d DateMeta) Compare(other DateMeta) int {
	return cmp.Or(d.Time.Compare(other.Time), cmp.Compare(d.Parts, other.Parts))
}

func cmpBool(a, b bool) int {
	if a == b {
		return 0
	}
	if !a && b {
		return -1
	}
	return 1
}
