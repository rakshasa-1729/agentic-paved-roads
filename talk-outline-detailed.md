# Agentic Paved Roads: Shifting Security Left to the Machine That Thinks
## CENTAUR TRACK • 20-MINUTE LIGHTNING TALK

## Core Thesis
AI is writing more code than humans. Security has always targeted the thinker—now the thinker is a model. The harness IS the new security culture.

## Talk Structure
| Time        | Section               | Purpose                          |
| ----------- | --------------------- | -------------------------------- |
| 0:00–3:00   | The Paradigm Shift    | Establish "why now"              |
| 3:00–6:00   | The Reframe           | Security culture → Model context |
| 6:00–8:00   | The Architecture      | MCP as control plane             |
| 8:00–15:00  | Live Demo             | End-to-end proof                 |
| 15:00–18:00 | Risk Scoring          | Exceptions at machine speed      |
| 18:00–20:00 | Results & Open Source | CTA + release                    |

## 1. The Paradigm Shift (3 min)

### Opening Hook
Slide: Graph showing AI-generated code volume crossing human-written code.
In 2024, AI wrote >50% of code. By 2025, approaching 70%.
We've crossed a line. AI is doing the development; humans are reviewers.
Traditional security (training, champions) targeted human cognition. What happens when cognition is delegated?

### The Problem Statement
Slide: Developer typing 3 sentences → Production EKS cluster deployed.
A junior engineer deployed a production EKS cluster in 12 minutes via chat.
Result: Public API, wildcard IAM, zero network policies.
The agent didn't bypass security; it just had no context. It wasn't in the loop.

## 2. The Reframe: Security Culture for Machines (3 min)

### The Old Model
Slide: "Shift Left" diagram pointing to developer's brain.
Old way: Train developers, constrain choices, review code. Assumed a human thinker.

### The New Model
Slide: "Shift Left to the Thinker" diagram pointing to model context window.
In agentic workflows, the model does the reasoning.
We can't program brains, but we CAN program model context.
The harness (tools, information, constraints) is the new security culture.
We shift left to the thinker itself.

## 3. The Architecture (2 min)

### MCP as the Control Plane
Slide: Architecture diagram.
We use Model Context Protocol (MCP) to define the agent's world.
If a tool isn't in the MCP server, the agent can't use it.
Slide: Tool list.
* `list_modules`: Fetch approved patterns
* `generate_terraform`: HCL constrained by patterns
* `validate_terraform`: Run fmt/validate/plan
* `run_policy_check`: OPA policies
* `fix_violations`: Auto-remediation
* `calculate_risk_score`: Compute risk
* `request_exception`: Submit request
* `submit_for_review`: Create PR

### The Key Insight
The agent never touches infrastructure it didn't generate. The paved road is all it sees.

## 4. Live Demo (7 min)

### Setup
Slide: Demo scenario.
Request: Isolated Redis cluster, 8h auto-expire, access to S3 data lake (analytics account).

### Demo Flow

#### Step 1: Intent → Modules
Agent calls `list_modules`. Finds approved modules: aws-elasticache-redis, ephemeral-resource, aws-iam-role-crossaccount.

#### Step 2: Generate Initial Code
Agent generates Terraform.

#### Step 3: Policy Check Fails
Policy check finds 14 violations (missing tags, open SG, missing external ID).
Output includes severity, remediation hints, and auto-fix flags.

#### Step 4: Auto-Remediation
Agent calls `fix_violations` for 13 auto-remediable issues.
Tags added, SG locked down.

#### Step 5: Risk Scoring & Exception
One violation remains: cross-account S3 access (not auto-fixable).
Risk score calculated: 31/100 (Blast radius low, Data medium, Compensating controls).
Score > 30 implies human review.
Agent creates Linear ticket with full context.

#### Step 6: Final Output
Compliant PR created with reasoning trace.
Total time: Under 5 minutes.

## 5. Risk Scoring: Exceptions at Machine Speed (3 min)

### The Problem with Binary Policies
Static policies create bottlenecks. AI needs risk-based automation.

### Risk-Based Automation
Slide: Risk scoring formula.
Factors: Blast radius, Data classification, Exposure, Temporal scope, Compensating controls.

### Thresholds
* < 30: Auto-approve (move fast).
* 30-70: Security queue (human decision).
* > 70: Hard block.

### Audit Trail
Every decision logged automatically.

## 6. Results & Call to Action (2 min)

### Metrics
Slide: Before/After comparison.
* Violations caught: 40% → 100%
* Deploy time: Days → Minutes
* PR review time: Reduced 60-70%
* Shadow IT: Near zero

### The Closing
Developers will use AI. Don't ban it.
Go where the thinking happens: the model context window.
The paved road just learned to drive itself.

### Open Source Release
Slide: GitHub repo.
Releasing: MCP Terraform Server, OPA policies, Risk engine, Linear integration, Slides.
License: Apache 2.0.
