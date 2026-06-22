package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"html/template"
	"os"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stdout, "error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var tree struct {
		Dir      string
		Children []Child
	}

	if err := json.NewDecoder(os.Stdin).Decode(&tree); err != nil {
		return err
	}

	if tree.Dir == "/" {
		for i, c := range tree.Children {
			if c.IsTree() && c.Name != "me" {
				tree.Children[i].Open = true
				break
			}
		}
	} else {
		for i := range tree.Children {
			tree.Children[i].IsReadMore = true
		}
	}

	return t.ExecuteTemplate(os.Stdout, "tree", tree.Children)
}

type Child struct {
	Date string
	Href string

	Title           template.HTML
	Subtitle        template.HTML
	Description     string
	Folder          string
	Index           bool
	TitleIsSubtitle bool
	IsReadMore      bool `json:"-"`

	Name     string
	Dir      string
	Children []Child
	Open     bool `json:"-"`
}

func (c Child) Slug() string {
	return strings.ReplaceAll(strings.TrimPrefix(c.Href, "/"), "/", "-")
}

func (c Child) ViewTransitionName() string {
	name := ""
	if c.TitleIsSubtitle {
		name = "sub-" + c.Slug()
	} else {
		name = "title-" + c.Slug()
	}
	if c.IsReadMore {
		name = "rm-" + name
	}
	return name
}

func (c Child) IsTree() bool {
	return c.Title == ""
}

//go:embed tree.html
var templateString string

var t = template.Must(template.New("").Parse(templateString))
