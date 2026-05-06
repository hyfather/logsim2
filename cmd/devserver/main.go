package main

import (
	"log"
	"net/http"

	"github.com/nikhilm/logsim2/api/generate"
	logsat "github.com/nikhilm/logsim2/api/logs_at"
	"github.com/nikhilm/logsim2/api/run"
	"github.com/nikhilm/logsim2/api/search"
)

func main() {
	http.HandleFunc("/api/generate", generate.Handler)
	http.HandleFunc("/api/run", run.Handler)
	http.HandleFunc("/api/logs_at", logsat.Handler)
	http.HandleFunc("/api/search", search.Handler)
	http.HandleFunc("/api/search/", search.Handler)
	log.Println("Go dev server on :8787 — /api/generate, /api/run, /api/logs_at, /api/search/*")
	log.Fatal(http.ListenAndServe(":8787", nil))
}
