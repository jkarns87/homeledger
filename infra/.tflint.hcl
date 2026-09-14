plugin "aws" {
  enabled = true
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
  version = "0.48.0"
}

rule "terraform_naming_convention" {
  enabled = true
}
