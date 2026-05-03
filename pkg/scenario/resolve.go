package scenario

import (
	"os"
	"strings"
)

// ResolveSource maps a user-supplied scenario reference to a loadable source.
// Resolution order:
//
//  1. http(s) URL — returned unchanged.
//  2. Existing local path — returned unchanged.
//  3. Bare slug ([A-Za-z0-9_-]+) — mapped to $LOGSIM_BASE_URL/s/<slug>.yaml.
//  4. Anything else — returned unchanged so downstream loaders surface a
//     "no such file" error against the original input.
//
// Step 3 is what lets `logsim run db-slowdown-cascade` work the same as
// `logsim run https://logsim2.vercel.app/s/db-slowdown-cascade.yaml`.
func ResolveSource(src string) string {
	s := strings.TrimSpace(src)
	if s == "" || IsHTTPURL(s) {
		return s
	}
	if _, err := os.Stat(s); err == nil {
		return s
	}
	if isSlug(s) {
		return SlugURL(s)
	}
	return s
}

// isSlug reports whether s is a kebab-case identifier — letters, digits, '-',
// and '_' only. Anything else (slashes, dots, spaces, '.yaml' suffix) is
// excluded so we don't accidentally rewrite a missing local file path.
func isSlug(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}
