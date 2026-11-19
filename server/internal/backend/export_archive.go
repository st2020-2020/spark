package backend

import (
	"archive/zip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"iter"
	"time"

	"github.com/jackc/pgx/v5"
)

// Merge two ordered keyset streams. A collection may have accumulated any
// number of decisions over its lifetime, so those are paged independently.
func writeExport(ctx context.Context, tx pgx.Tx, uid string, z *zip.Writer, format string, at time.Time) (int, error) {
	s := exportSnapshot{ctx, tx, uid}
	var data io.Writer
	var md markdownArchive
	var err error
	if format == "json" {
		data, err = z.Create("spark-export.json")
		if err == nil {
			_, err = fmt.Fprintf(data, `{"version":1,"exported_at":%q,"projects":[`, at.UTC().Format(time.RFC3339Nano))
		}
	} else {
		md = newMarkdownArchive(z)
		err = md.readme(at)
	}
	if err != nil {
		return 0, err
	}
	first := true
	for p, err := range s.projects() {
		if err != nil {
			return 0, err
		}
		if data != nil {
			err = writeExportJSON(data, p, first)
		} else {
			err = md.project(p)
		}
		if err != nil {
			return 0, err
		}
		first = false
	}
	if data != nil {
		if _, err = io.WriteString(data, `],"collections":[`); err != nil {
			return 0, err
		}
	}
	next, stop := iter.Pull2(s.decisions())
	defer stop()
	d, linkErr, ok := next()
	count := 0
	for c, err := range s.collections() {
		if err != nil {
			return count, err
		}
		if linkErr != nil {
			return count, linkErr
		}
		var entry io.Writer
		if data != nil {
			err = startJSONCollection(data, c, count == 0)
		} else {
			folder := "unclassified"
			if ok && d.collectionID == c.ID && !d.unassigned {
				folder = md.folders[d.ProjectId]
			}
			entry, err = md.collection(folder, c)
		}
		if err != nil {
			return count, err
		}
		firstLink := true
		for ok && d.collectionID == c.ID {
			if data != nil {
				err = writeExportJSON(data, d.ProjectAssociation, firstLink)
			} else {
				_, err = fmt.Fprintf(entry, "- %s（%s）\n", mdLine(d.Name), d.Decision)
			}
			if err != nil {
				return count, err
			}
			firstLink = false
			d, linkErr, ok = next()
			if linkErr != nil {
				return count, linkErr
			}
		}
		if data != nil {
			_, err = io.WriteString(data, "]}")
		} else {
			body, convErr := documentMarkdown(c.Document)
			if convErr != nil {
				return count, convErr
			}
			_, err = fmt.Fprintf(entry, "\n## 正文\n\n%s\n", body)
		}
		if err != nil {
			return count, err
		}
		count++
	}
	if linkErr != nil {
		return count, linkErr
	}
	if data != nil {
		_, err = io.WriteString(data, "]}")
	}
	return count, err
}

// Leave the projects array open so its decisions can be written a page at a time.
func startJSONCollection(w io.Writer, c exportCollection, first bool) error {
	record, err := json.Marshal(c)
	if err != nil {
		return err
	}
	if !first {
		if _, err = io.WriteString(w, ","); err != nil {
			return err
		}
	}
	if _, err = w.Write(record[:len(record)-1]); err != nil {
		return err
	}
	_, err = io.WriteString(w, `,"projects":[`)
	return err
}

func writeExportJSON(w io.Writer, v any, first bool) error {
	if !first {
		if _, err := io.WriteString(w, ","); err != nil {
			return err
		}
	}
	return json.NewEncoder(w).Encode(v)
}
