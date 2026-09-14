terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.21"
    }
  }
}

provider "aws" {
  region = var.region
  default_tags {
    tags = {
      project    = "homeledger"
      env        = var.env
      managed_by = "terraform"
    }
  }
}
