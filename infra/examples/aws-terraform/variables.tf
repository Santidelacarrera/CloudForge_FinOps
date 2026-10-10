variable "region" {
  type    = string
  default = "us-east-1"
}
variable "name_prefix" {
  type    = string
  default = "cloudforge"
}
variable "trusted_principal_arns" {
  description = "Principals (the CloudForge control plane / workers) allowed to assume the roles."
  type        = list(string)
}
variable "external_id" {
  description = "ExternalId required on AssumeRole (confused-deputy protection)."
  type        = string
  sensitive   = true
}
variable "remediation_enabled" {
  description = "The remediation role is created only when explicitly enabled."
  type        = bool
  default     = false
}
