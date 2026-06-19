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
	Name     string
	Href     string
	Dir      string `json:"-"`
	Date     DateMeta
	Children []Child
}

func (t Tree) compare(u Child) int {
	switch u := u.(type) {
	case Tree:
		return cmp.Or(
			u.Date.Compare(t.Date),
			strings.Compare(t.Name, u.Name),
		)
	case Article:
		return cmp.Or(
			u.Date.Compare(t.Date),
			strings.Compare(t.Name, u.Title),
		)
	default:
		return 0
	}
}

func (t Tree) Extract(depth int) Tree {
	c := Tree{
		Name:     t.Name,
		Href:     t.Href,
		Dir:      t.Dir,
		Date:     t.Date,
		Children: []Child{},
	}
	if depth > 0 {
		for _, child := range t.Children {
			if ct, ok := child.(Tree); ok {
				c.Children = append(c.Children, ct.Extract(depth-1))
			} else {
				c.Children = append(c.Children, child)
			}
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
		if ct, ok := c.(Tree); ok && !ct.walk(yield) {
			return false
		}
	}
	return true
}

type Child interface {
	compare(Child) int
}

type Article struct {
	Title       string
	Subtitle    string
	Date        DateMeta
	Description string
	Href        string
	Folder      string
	Index       bool
}

func (a Article) compare(b Child) int {
	switch b := b.(type) {
	case Article:
		return cmp.Or(
			cmpBool(b.Index && b.Folder == "", a.Index && a.Folder == ""),
			b.Date.Compare(a.Date),
			strings.Compare(a.Title, b.Title),
			strings.Compare(a.Subtitle, b.Subtitle),
		)
	case Tree:
		return cmp.Or(
			b.Date.Compare(a.Date),
			strings.Compare(a.Title, b.Name),
		)
	default:
		return 0
	}
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
		if a.Date.Compare(t.Date) > 0 {
			t.Date = a.Date
		}
		t.Children = append(t.Children, a)
	}

	for _, childDir := range dirs[entrypoint] {
		ct, err := buildTree(childDir, dirs, filesInDirs, inDir)
		if errors.Is(err, errNoChildren) {
			continue
		} else if err != nil {
			return Tree{}, fmt.Errorf("for %q: %w", childDir, err)
		}
		if ct.Date.Compare(t.Date) > 0 {
			t.Date = ct.Date
		}
		if c, ok := ct.Children[0].(Article); ok && len(ct.Children) == 1 {
			if c.Folder == "" {
				c.Folder = ct.Name
			} else {
				c.Folder = ct.Name + "/" + c.Folder
			}
			t.Children = append(t.Children, c)
		} else {
			t.Children = append(t.Children, ct)
		}
	}

	if l := len(t.Children); l == 0 {
		return Tree{}, errNoChildren
	} else if c, ok := t.Children[0].(Tree); ok && l == 1 {
		c.Name = t.Name + "/" + c.Name
		return c, nil
	}

	slices.SortStableFunc(t.Children, Child.compare)

	return t, nil
}

var errNoChildren = errors.New("no articles")

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
