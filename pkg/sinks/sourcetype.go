package sinks

// splunkSourcetype maps a sourcetype kind to a Splunk-convention sourcetype
// (lowercase, colon-separated, vendor:product[:format]). Splunk uses sourcetype to
// pick parsing rules, so each log format needs a distinct value.
func splunkSourcetype(sourcetype string) string {
	switch sourcetype {
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
	default:
		return sourcetype
	}
}
