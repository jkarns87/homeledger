variable "name_prefix" {
  type        = string
  description = "Prefix applied to every resource name in this module, e.g. \"demo-homeledger\"."

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,40}$", var.name_prefix))
    error_message = "name_prefix must be lowercase letters, digits, and hyphens, 2 to 41 characters."
  }
}

variable "household_id" {
  type        = string
  description = "Household id. Manuals live under manuals/<household_id>/ in the bucket, and the data source ingests only that prefix."

  validation {
    condition     = can(regex("^hh_[a-z0-9_]+$", var.household_id))
    error_message = "household_id must match ^hh_[a-z0-9_]+$."
  }
}

variable "embedding_model_arn" {
  type        = string
  description = "ARN of the Bedrock embedding model the knowledge base uses. Titan Text Embeddings v2 by default; it must be enabled in this account and region."
  default     = ""
}

variable "vector_dimension" {
  type        = number
  description = "Embedding dimension of the S3 Vectors index. Titan Text Embeddings v2 emits 1024 by default and also supports 512 and 256."
  default     = 1024

  validation {
    condition     = contains([256, 512, 1024], var.vector_dimension)
    error_message = "vector_dimension must be 256, 512, or 1024 to match Titan Text Embeddings v2."
  }
}

variable "force_destroy" {
  type        = bool
  description = "Whether the manuals bucket may be destroyed while it still holds objects. True in the demo environment so teardown is one command."
  default     = true
}
