package sinks

// splunkSourcetype maps a logsim generator kind to a Splunk-convention sourcetype
// (lowercase, colon-separated, vendor:product[:format]). Splunk uses sourcetype to
// pick parsing rules, so each log format needs a distinct value.
func splunkSourcetype(generator string) string {
	switch generator {
	case "mysql":
		return "mysql:query"
	case "postgres":
		return "postgresql"
	case "nginx":
		return "nginx:access"
	case "nodejs":
		return "nodejs"
	case "golang":
		return "golang"
	case "redis":
		return "redis:log"
	case "vpc-flow":
		return "aws:vpcflow"
	case "logsim", "logsim-test":
		return "logsim:test"
	case "", "custom":
		return "logsim:custom"
	default:
		return generator
	}
}
