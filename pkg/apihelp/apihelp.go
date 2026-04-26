// Package apihelp holds shared helpers used by every Vercel /api Lambda
// handler so each subdirectory can stay slim.
package apihelp

import (
	"fmt"
	"net/http"
)

// CriblConfig is the subset of a Cribl Stream HEC destination the frontend
// hands us per request. Tokens live in localStorage on the client — we only
// see them for the duration of one invocation.
type CriblConfig struct {
	Enabled    bool   `json:"enabled"`
	URL        string `json:"url"`
	Token      string `json:"token"`
	Sourcetype string `json:"sourcetype"`
}

// SetCORS writes permissive CORS headers. The frontend may run from a
// different origin during local dev; in production both share a domain.
func SetCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

// WriteErr emits a JSON error body with the given status code.
func WriteErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	fmt.Fprintf(w, `{"error":%q}`, msg)
}
