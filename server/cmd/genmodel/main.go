// Command genmodel embeds the shared model-output contract for the standalone Worker.
package main

import (
	"encoding/json"
	"fmt"
	"go/format"
	"os"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: genmodel INPUT_SCHEMA OUTPUT_GO")
		os.Exit(2)
	}
	if err := generate(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func generate(input, output string) error {
	schema, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	if !json.Valid(schema) {
		return fmt.Errorf("model schema is not valid JSON")
	}
	code := fmt.Sprintf("// Code generated from contracts/organization-result.schema.json. DO NOT EDIT.\npackage backend\n\nconst organizationResultSchema = %q\n", schema)
	formatted, err := format.Source([]byte(code))
	if err != nil {
		return err
	}
	return os.WriteFile(output, formatted, 0644)
}
