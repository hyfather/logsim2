package scenario

// Scenario is the fully parsed and validated in-memory representation.
type Scenario struct {
	Name           string       `yaml:"name"`
	Description    string       `yaml:"description"`
	Duration       int          `yaml:"duration,omitempty"`         // total ticks for the episode
	TickIntervalMs int          `yaml:"tick_interval_ms,omitempty"` // simulated ms per tick
	Nodes          []Node       `yaml:"nodes"`
	Services       []Service    `yaml:"services"`
	Connections    []Connection `yaml:"connections"`
	CustomTypes    []CustomType `yaml:"custom_types,omitempty"`
	Editor         *EditorMeta  `yaml:"editor,omitempty"`
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
	// ServiceTypeCustom is rendered by CustomGenerator using the CustomType
	// referenced by GeneratorConfig.CustomType.
	ServiceTypeCustom ServiceType = "custom"
)

// Service represents an application or database running on a host.
type Service struct {
	Type        ServiceType     `yaml:"type"`
	Name        string          `yaml:"name"`
	Description string          `yaml:"description,omitempty"`
	Host        string          `yaml:"host"` // required: name of a virtual_server node
	Generator   GeneratorConfig `yaml:"generator"`
	// Timeline is an ordered list of behavior blocks that override generator
	// behavior over [from, to) tick ranges. Blocks may overlap; later blocks
	// in slice order win for overlapping ticks.
	Timeline []TimelineBlock `yaml:"timeline,omitempty"`
}

// TimelineBlock declares a behavior override for one service over [From, To)
// ticks. Pointer fields are tri-state: nil means inherit baseline, non-nil
// means apply this value (after the State preset). State sets default
// modifiers; explicit fields then override the state's defaults.
type TimelineBlock struct {
	From            int                    `yaml:"from"`
	To              int                    `yaml:"to"`
	State           string                 `yaml:"state,omitempty"`
	ErrorRate       *float64               `yaml:"error_rate,omitempty"`
	LatencyMul      *float64               `yaml:"latency_mul,omitempty"`
	LogVolMul       *float64               `yaml:"log_vol_mul,omitempty"`
	LogVolAbs       *float64               `yaml:"log_vol_abs,omitempty"`
	TemplateWeights map[string]float64     `yaml:"template_weights,omitempty"`
	Placeholders    map[string]Placeholder `yaml:"placeholders,omitempty"`
	CustomLog       string                 `yaml:"custom_log,omitempty"`
	Note            string                 `yaml:"note,omitempty"`
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
	// CustomType references an entry in Scenario.CustomTypes by id; required
	// when Type == "custom".
	CustomType string `yaml:"custom_type,omitempty"`
}

// CustomType is a user-defined log shape: a set of weighted templates plus
// the placeholders they reference. Mirrors src/types/customNodeType.ts so
// the frontend preview and the backend generator agree on output.
type CustomType struct {
	ID               string                 `yaml:"id"`
	Name             string                 `yaml:"name,omitempty"`
	Description      string                 `yaml:"description,omitempty"`
	DefaultPort      int                    `yaml:"default_port,omitempty"`
	DefaultRate      float64                `yaml:"default_rate,omitempty"`
	DefaultErrorRate float64                `yaml:"default_error_rate,omitempty"`
	Placeholders     map[string]Placeholder `yaml:"placeholders,omitempty"`
	Templates        []LogTemplate          `yaml:"templates"`
}

// Placeholder controls how a `{{name}}` marker in a template is filled.
// Kinds match the frontend's PlaceholderKind enum.
type Placeholder struct {
	Kind        string   `yaml:"kind"`
	EnumValues  []string `yaml:"enum_values,omitempty"`
	Literal     string   `yaml:"literal,omitempty"`
	Min         *float64 `yaml:"min,omitempty"`
	Max         *float64 `yaml:"max,omitempty"`
	Format      string   `yaml:"format,omitempty"`
	Length      int      `yaml:"length,omitempty"`
	Description string   `yaml:"description,omitempty"`
}

// LogTemplate is one weighted output line within a CustomType.
// ID is stable across positions so timeline blocks can target templates by
// name; if absent at parse time, parser auto-assigns "tpl_<index>".
type LogTemplate struct {
	ID       string  `yaml:"id,omitempty"`
	Template string  `yaml:"template"`
	Weight   float64 `yaml:"weight,omitempty"`
	Level    string  `yaml:"level,omitempty"`
	IsError  bool    `yaml:"is_error,omitempty"`
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
