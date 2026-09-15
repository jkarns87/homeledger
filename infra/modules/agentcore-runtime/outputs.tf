output "role_arn" {
  description = "ARN of the IAM execution role created for the runtime."
  value       = aws_iam_role.this.arn
}

output "agent_runtime_arn" {
  description = "ARN of the AgentCore runtime. Empty string until image_uri is set and the runtime is created."
  value       = try(aws_bedrockagentcore_agent_runtime.this[0].agent_runtime_arn, "")
}

output "invocation_url" {
  description = "HTTPS invocation URL for the runtime's DEFAULT endpoint. Empty string until the runtime is created."
  value       = try("https://bedrock-agentcore.${local.region}.amazonaws.com/runtimes/${urlencode(aws_bedrockagentcore_agent_runtime.this[0].agent_runtime_arn)}/invocations?qualifier=DEFAULT", "")
}

output "runtime_id" {
  description = "AgentCore runtime id. Empty string until the runtime is created."
  value       = try(aws_bedrockagentcore_agent_runtime.this[0].agent_runtime_id, "")
}

output "environment_variables" {
  description = "Environment variables applied to the runtime container, for callers (and tests) that need to assert on a specific value. Empty map until the runtime is created."
  value       = try(aws_bedrockagentcore_agent_runtime.this[0].environment_variables, {})
}
