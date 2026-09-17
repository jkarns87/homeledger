output "manuals_bucket" {
  description = "Name of the S3 bucket holding manual PDFs and their metadata sidecars."
  value       = aws_s3_bucket.manuals.bucket
}

output "manuals_bucket_arn" {
  description = "ARN of the manuals bucket."
  value       = aws_s3_bucket.manuals.arn
}

output "manuals_prefix" {
  description = "Key prefix inside the manuals bucket that the data source ingests."
  value       = local.manuals_prefix
}

output "knowledge_base_id" {
  description = "Bedrock Knowledge Base id, passed to the runtime as KNOWLEDGE_BASE_ID."
  value       = aws_bedrockagent_knowledge_base.manuals.id
}

output "knowledge_base_arn" {
  description = "Bedrock Knowledge Base ARN, granted to the runtime execution role for bedrock:Retrieve."
  value       = aws_bedrockagent_knowledge_base.manuals.arn
}

output "data_source_id" {
  description = "Bedrock data source id, used by the manuals ingestion script to start ingestion jobs."
  value       = aws_bedrockagent_data_source.manuals.data_source_id
}

output "vector_index_arn" {
  description = "ARN of the S3 Vectors index backing the knowledge base."
  value       = aws_s3vectors_index.manuals.index_arn
}
