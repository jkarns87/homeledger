variable "region" {
  type        = string
  description = "AWS region to deploy into."
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "region must look like an AWS region, e.g. us-east-1."
  }
}

variable "env" {
  type        = string
  description = "Deployment environment name. Only \"demo\" exists today; later layers (events, simulator) will live under infra/live/demo/ alongside this root."
  default     = "demo"

  validation {
    condition     = contains(["demo"], var.env)
    error_message = "env must be \"demo\"."
  }
}

variable "household_id" {
  type        = string
  description = "Household id seeded into the MCP server's environment as HOUSEHOLD_ID."
  default     = "hh_harlow"

  validation {
    condition     = can(regex("^hh_[a-z0-9_]+$", var.household_id))
    error_message = "household_id must match ^hh_[a-z0-9_]+$."
  }
}

variable "image_uri" {
  type        = string
  description = "Full ECR image URI with tag, from scripts/build-image.sh. Empty on the first apply, which then creates only ECR, the table, Cognito, and the execution role."
  default     = ""

  validation {
    condition     = var.image_uri == "" || can(regex("^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-zA-Z0-9._/-]+:[a-zA-Z0-9._-]+$", var.image_uri))
    error_message = "image_uri must be empty or a full ECR image URI with a tag, e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/homeledger-mcp:abc1234."
  }
}

variable "idle_session_timeout_seconds" {
  type        = number
  description = "Idle runtime session timeout passed to the AgentCore runtime, in seconds."
  default     = 1800

  validation {
    condition     = var.idle_session_timeout_seconds >= 60 && var.idle_session_timeout_seconds <= 28800
    error_message = "idle_session_timeout_seconds must be between 60 and 28800."
  }
}

variable "allowed_hosts" {
  type        = string
  description = "Comma-separated Host header allowlist passed to the server as ALLOWED_HOSTS, or \"*\" to disable Host-header validation entirely. Defaults to \"*\" because under AgentCore Runtime the container is reachable only through the authenticated invocation endpoint (the JWT authorizer is the access control there), and the Host header AgentCore actually forwards is an internal, undocumented, cell-specific name (observed: cell01.us-east-1.prod.arp.kepler-analytics.aws.dev) that cannot be pinned in advance. Local runs pass an explicit list (e.g. \"localhost,127.0.0.1,0.0.0.0\") to keep DNS-rebinding protection there."
  default     = "*"
}

variable "dev_tools_enabled" {
  type        = bool
  description = "Whether the deployed runtime registers developer-only MCP tools (currently echo_confirm) via HOMELEDGER_DEV_TOOLS. Defaults to true for the demo: echo_confirm is the concrete proof that the elicitation round trip works end to end through AgentCore, and the demo deliberately ships it enabled rather than hidden."
  default     = true
}
