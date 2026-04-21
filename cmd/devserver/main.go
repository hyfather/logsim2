package main

import (
    "log"
    "net/http"
    handler "github.com/nikhilm/logsim2/api"
)

func main() {
    http.HandleFunc("/api/generate", handler.Handler)
    log.Println("Go dev server on :8787")
    log.Fatal(http.ListenAndServe(":8787", nil))
}
