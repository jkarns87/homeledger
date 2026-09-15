terraform {
  backend "s3" {
    key          = "homeledger/demo/terraform.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}
