package scenario

// Scenario is the fully parsed and validated in-memory representation.
type Scenario struct {
	Name        string       `yaml:"name"`
	Description string       `yaml:"description"`
	Nodes       []Node       `yaml:"nodes"`
	Services    []Service    `yaml:"services"`
	Connections []Connection `yaml:"connections"`
	Editor      *EditorMeta  `yaml:"editor,omitempty"`
}

// NodeType classifies infrastructure components.
type NodeType string

const (
	NodeTypeVPC           NodeType = "vpc"
	NodeTypeSubnet        NodeType = "subnet"
	NodeTypeVirtualServer NodeType = "virtual_server"
	NodeTypeLoadBalancer  NodeType = "load_balancer"
	NodeTypeUserClients   NodeType = "user_clients"
)

// Node represents one infrastructure component.
type Node struct {
	Type           NodeType          `yaml:"type"`
	Name           string            `yaml:"name"`
	Description    string            `yaml:"description,omitempty"`
	Provider       string            `yaml:"provider,omitempty"`
	Region         string            `yaml:"region,omitempty"`
	CIDRBlock      string            `yaml:"cidr_block,omitempty"`
	InstanceType   string            `yaml:"instance_type,omitempty"`
	OS             string            `yaml:"os,omitempty"`
	PrivateIP      string            `yaml:"private_ip,omitempty"`
	Subnet         string            `yaml:"subnet,omitempty"`         // name of parent subnet
	SecurityGroups []string          `yaml:"security_groups,omitempty"`
	Tags           []map[string]string `yaml:"tags,omitempty"`
	Clients        []Client          `yaml:"clients,omitempty"` // only for user_clients type
}

// Client is one user agent inside a user_clients node.
type Client struct {
	Type           string  `yaml:"type,omitempty"`
	Name           string  `yaml:"name"`
	Description    string  `yaml:"description,omitempty"`
	UserAgent      string  `yaml:"user-agent,omitempty"`
	IP             string  `yaml:"ip"`
	RPS            float64 `yaml:"rps"`
	TrafficPattern string  `yaml:"traffic_pattern"`
}

// ServiceType identifies the log generator to use.
type ServiceType string

const (
	ServiceTypeNodejs   ServiceType = "nodejs"
	ServiceTypeGolang   ServiceType = "golang"
	ServiceTypeMySQL    ServiceType = "mysql"
	ServiceTypePostgres ServiceType = "postgres"
	ServiceTypeRedis    ServiceType = "redis"
	ServiceTypeNginx    ServiceType = "nginx"
	ServiceTypeCustom   ServiceType = "custom"
)

// Service represents an application or database running on a host.
type Service struct {
	Type        ServiceType     `yaml:"type"`
	Name        string          `yaml:"name"`
	Description string          `yaml:"description,omitempty"`
	Host        string          `yaml:"host"` // required: name of a virtual_server node
	Generator   GeneratorConfig `yaml:"generator"`
}

// GeneratorConfig is the type-specific config block inside a service.
type GeneratorConfig struct {
	Type               string     `yaml:"type"`
	Port               int        `yaml:"port,omitempty"`
	LogFormat          string     `yaml:"log_format,omitempty"` // "json" | "text"
	LogLevel           string     `yaml:"log_level,omitempty"`
	Endpoints          []Endpoint `yaml:"endpoints,omitempty"`
	Database           string     `yaml:"database,omitempty"`
	SlowQueryThreshold int        `yaml:"slow_query_threshold,omitempty"` // ms
	MaxMemory          string     `yaml:"max_memory,omitempty"`
	EvictionPolicy     string     `yaml:"eviction_policy,omitempty"`
	ErrorRate          float64    `yaml:"error_rate,omitempty"`
	TrafficRate        float64    `yaml:"traffic_rate,omitempty"`
}

// Endpoint defines one HTTP route on a service.
type Endpoint struct {
	Method       string  `yaml:"method"`
	Path         string  `yaml:"path"`
	AvgLatencyMs int     `yaml:"avg_latency_ms"`
	ErrorRate    float64 `yaml:"error_rate"`
}

// Connection wires two named nodes or services together.
type Connection struct {
	Source   string `yaml:"source"`
	Target   string `yaml:"target"`
	Protocol string `yaml:"protocol"`
	Port     int    `yaml:"port"`
}

// EditorMeta carries UI-only positioning data; ignored by the engine.
type EditorMeta struct {
	Nodes map[string]EditorNodeMeta `yaml:"nodes,omitempty"`
}

// EditorNodeMeta stores canvas position/size for one node.
type EditorNodeMeta struct {
	Position struct {
		X float64 `yaml:"x"`
		Y float64 `yaml:"y"`
	} `yaml:"position,omitempty"`
	Size struct {
		Width  float64 `yaml:"width"`
		Height float64 `yaml:"height"`
	} `yaml:"size,omitempty"`
}
