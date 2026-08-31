# Model HumanPost account operations

Type: research
Status: resolved

## Question

How does HumanPost coordinate account provisioning, warm-up, posting, proof, replacement, and measurement, and what should MarketingOS implement independently?

## Answer

HumanPost coordinates manual work through software. MarketingOS should keep durable Account Slots separate from replaceable Account Instances and model warm-up, posting, proof, review, replacement, and measurement as explicit Work Orders and state machines. The first Operator can perform the work without a labor marketplace. See [the HumanPost account-warming report](../research/humanpost-account-warming.md).
