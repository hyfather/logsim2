package scenario

import (
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

var normalizeRe = regexp.MustCompile(`\s+`)

// normalizeType converts a type string to snake_case:
// "User Clients" → "user_clients", "load_balancer" → "load_balancer"
func normalizeType(s string) string {
	s = strings.TrimSpace(s)
	s = strings.ToLower(s)
	s = normalizeRe.ReplaceAllString(s, "_")
	return s
}

// Parse reads a scenario YAML and returns the parsed Scenario.
// The format is a top-level YAML list of single-key maps:
//
//	- name: My Scenario
//	- description: ...
//	- nodes: [...]
//	- services: [...]
//	- connections: [...]
//	- editor: {...}   (optional, ignored by engine)
//
// A plain top-level map is also accepted for convenience.
func Parse(r io.Reader) (*Scenario, error) {
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}

	// Try list-of-single-key-maps format first.
	var items []map[string]yaml.Node
	if err := yaml.Unmarshal(raw, &items); err != nil || items == nil {
		// Fall back to plain map.
		var m map[string]yaml.Node
		if merr := yaml.Unmarshal(raw, &m); merr != nil {
			return nil, fmt.Errorf("yaml parse: %w", merr)
		}
		for k, v := range m {
			items = append(items, map[string]yaml.Node{k: v})
		}
	}

	s := &Scenario{}
	for _, item := range items {
		for key, valNode := range item {
			if err := applyTopLevelKey(s, strings.ToLower(strings.TrimSpace(key)), &valNode); err != nil {
				return nil, fmt.Errorf("key %q: %w", key, err)
			}
		}
	}

	if s.Name == "" {
		return nil, fmt.Errorf("scenario must have a non-empty 'name'")
	}
	return s, nil
}

func applyTopLevelKey(s *Scenario, key string, node *yaml.Node) error {
	switch key {
	case "name":
		return node.Decode(&s.Name)
	case "description":
		if err := node.Decode(&s.Description); err != nil {
			return err
		}
		s.Description = strings.TrimSpace(s.Description)
		return nil
	case "nodes":
		if err := node.Decode(&s.Nodes); err != nil {
			return err
		}
		for i := range s.Nodes {
			s.Nodes[i].Type = NodeType(normalizeType(string(s.Nodes[i].Type)))
		}
		return nil
	case "services":
		if err := node.Decode(&s.Services); err != nil {
			return err
		}
		for i := range s.Services {
			s.Services[i].Type = ServiceType(normalizeType(string(s.Services[i].Type)))
		}
		return nil
	case "connections":
		return node.Decode(&s.Connections)
	case "duration":
		return node.Decode(&s.Duration)
	case "tick_interval_ms":
		return node.Decode(&s.TickIntervalMs)
	case "custom_types":
		if err := node.Decode(&s.CustomTypes); err != nil {
			return err
		}
		assignTemplateIDs(s.CustomTypes)
		return nil
	case "editor":
		s.Editor = &EditorMeta{}
		return node.Decode(s.Editor)
	default:
		return nil // forward-compat: ignore unknown keys
	}
}

// assignTemplateIDs fills in Template.ID for any template that omitted it,
// using "tpl_<index>". Stable ids let timeline blocks reference templates by
// name rather than position.
func assignTemplateIDs(cts []CustomType) {
	for i := range cts {
		ct := &cts[i]
		used := make(map[string]bool, len(ct.Templates))
		for j := range ct.Templates {
			if id := strings.TrimSpace(ct.Templates[j].ID); id != "" {
				used[id] = true
			}
		}
		for j := range ct.Templates {
			if strings.TrimSpace(ct.Templates[j].ID) != "" {
				continue
			}
			candidate := fmt.Sprintf("tpl_%d", j)
			for used[candidate] {
				candidate += "_x"
			}
			ct.Templates[j].ID = candidate
			used[candidate] = true
		}
	}
}

// ParseFile parses a scenario from a file path.
func ParseFile(path string) (*Scenario, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open %q: %w", path, err)
	}
	defer f.Close()
	return Parse(f)
}
