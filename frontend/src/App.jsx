import { useState, useEffect, useCallback } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import { useTasks, useProtocolStats, useCreateTask, useAgentProfile, useMyTasks, useBidFlow, useCriteriaFromIPFS } from "./hooks";

// ═══════════════════════════════════════════════════
// COMPREHENSIVE ERROR MESSAGE MAPPING
// Every ArenaCore revert reason → user-friendly message
// ═══════════════════════════════════════════════════

const REVERT_MESSAGES = {
  // ── Core Task Lifecycle ──
  "Arena: bounty must be > 0":           "Bounty must be greater than zero.",
  "Arena: deadline must be future":       "Deadline must be in the future.",
  "Arena: invalid verifier count":        "Verifier count must be between 1 and 5.",
  "Arena: bid duration must be > 0":      "Bid duration must be greater than zero.",
  "Arena: reveal duration must be > 0":   "Reveal duration must be greater than zero.",
  "Arena: not task poster":               "Only the task poster can perform this action.",
  "Arena: not assigned agent":            "Only the assigned agent can perform this action.",
  "Arena: invalid task status":           "Task is not in the correct status for this action.",
  "Arena: agent is banned":               "This agent has been banned from the protocol.",
  "Arena: task not open":                 "Task is not open for this action.",

  // ── Bidding ──
  "Arena: poster cannot bid":             "The task poster cannot bid on their own task.",
  "Arena: bidding closed":                "The bidding period has closed.",
  "Arena: already bid":                   "You have already placed a bid on this task.",
  "Arena: max bidders reached":           "Maximum number of bidders has been reached.",
  "Arena: too many active bids":          "You have too many active bids. Complete or cancel existing bids first.",
  "Arena: not in reveal period":          "The reveal period has not started yet. Wait for bidding to close.",
  "Arena: no bid committed":              "No bid was committed. You must commit a bid before revealing.",
  "Arena: already revealed":              "Your bid has already been revealed.",
  "Arena: invalid reveal":                "Reveal data does not match your sealed commitment. Check stake, price, ETA, and salt.",
  "Arena: stake below minimum":           "Stake must be at least 10% of the bounty.",
  "Arena: price exceeds bounty":          "Your asking price cannot exceed the task bounty.",
  "Arena: eta must be > 0":              "Estimated time of arrival must be greater than zero.",
  "Arena: reveal period not ended":       "Cannot resolve auction until the reveal period ends.",
  "Arena: no bids":                       "No bids were submitted for this task.",
  "Arena: no valid bids":                 "No valid bids were found after evaluation.",

  // ── Delivery & Verification ──
  "Arena: empty output":                  "Output hash cannot be empty. Provide a valid delivery hash.",
  "Arena: deadline passed":               "The execution deadline has passed.",
  "Arena: not enough verifiers in pool":  "Not enough verifiers are registered in the pool.",
  "Arena: agent cannot verify own work":  "An agent cannot verify their own task delivery.",
  "Arena: poster cannot verify":          "The task poster cannot act as a verifier.",
  "Arena: verifier slots full":           "All verifier slots for this task are filled.",
  "Arena: already registered as verifier":"You are already registered as a verifier for this task.",
  "Arena: verifier stake too low":        "Verifier stake does not meet the minimum requirement.",
  "Arena: invalid vote":                  "Vote must be either Approved or Rejected.",
  "Arena: empty report":                  "Verification report hash cannot be empty.",
  "Arena: not a registered verifier":     "You are not a registered verifier for this task.",
  "Arena: not all verifiers registered":  "Not all required verifiers have registered yet.",
  "Arena: no assignment timestamp":       "No assignment timestamp found for this task.",
  "Arena: timeout not reached":           "Verifier timeout period has not elapsed yet.",
  "Arena: no timed-out verifiers":        "No verifiers have timed out for this task.",

  // ── Verifier Registry ──
  "Arena: already in verifier pool":      "You are already registered in the verifier pool.",
  "Arena: not in verifier pool":          "You are not currently in the verifier pool.",

  // ── VRF ──
  "Arena: invalid coordinator":           "Invalid VRF coordinator address.",
  "Arena: only VRF coordinator":          "This function can only be called by the VRF coordinator.",
  "Arena: pool too small":                "Verifier pool is too small for random selection.",
  "Arena: could not select enough verifiers": "Unable to select enough verifiers from the pool.",
  "Arena: not selecting arbitrators":     "Arbitration is not in the selection phase.",
  "Arena: could not select enough arbitrators": "Unable to select enough arbitrators from the pool.",

  // ── Disputes & Arbitration ──
  "Arena: dispute already exists":        "A dispute has already been raised for this task.",
  "Arena: not enough agents in pool for arbitration": "Not enough agents in pool to form an arbitration council.",
  "Arena: not in staking phase":          "Dispute is not in the arbitrator staking phase.",
  "Arena: staking deadline passed":       "The arbitrator staking deadline has passed.",
  "Arena: not a selected arbitrator":     "You were not selected as an arbitrator for this dispute.",
  "Arena: already staked":                "You have already staked for this arbitration.",
  "Arena: not in voting phase":           "Dispute is not in the voting phase.",
  "Arena: voting deadline passed":        "The arbitration voting deadline has passed.",
  "Arena: not an arbitrator":             "You are not an arbitrator for this dispute.",
  "Arena: not staked":                    "You must stake before voting in arbitration.",
  "Arena: already voted":                 "You have already cast your vote.",
  "Arena: staking deadline not passed":   "The staking deadline has not passed yet.",
  "Arena: voting deadline not passed":    "The voting deadline has not passed yet.",

  // ── Post-Completion Slash ──
  "Arena: deadline not passed":           "The task deadline has not passed yet.",
  "Arena: not completed":                 "Task must be in Completed status.",
  "Arena: no slash bond":                 "No slash bond was posted for this task.",
  "Arena: task not completed":            "Task must be in Completed status for this action.",
  "Arena: no bond to claim":              "No bond available to claim.",

  // ── Honeypot ──
  "Arena: empty correct hash":            "Honeypot tasks require a valid correct output hash.",
  "Arena: not a honeypot task":           "This task is not a honeypot task.",

  // ── Treasury ──
  "Arena: no fees to withdraw":           "Protocol treasury has no fees available.",

  // ── Continuous Contracts ──
  "Arena: interval must divide evenly into duration": "Checkpoint interval must divide evenly into the contract duration.",
  "Arena: need at least 2 checkpoints":   "Continuous contracts require at least 2 checkpoints.",
  "Arena: invalid max failures":          "Max failures must be between 1 and total checkpoints.",
  "Arena: not poster":                    "Only the contract poster can perform this action.",
  "Arena: not open for bids":             "This continuous contract is not open for bidding.",
  "Arena: too many active continuous contracts": "You have too many active continuous contracts.",
  "Arena: agent on slash cooldown":       "This agent is on a cooldown period after being slashed.",
  "Arena: contract not active":           "This continuous contract is not currently active.",
  "Arena: wrong checkpoint index":        "Checkpoint index does not match the expected next checkpoint.",
  "Arena: checkpoint already submitted":  "This checkpoint has already been submitted.",
  "Arena: checkpoint not pending":        "This checkpoint is not in a pending state.",
  "Arena: checkpoint not in verification":"This checkpoint is not in the verification phase.",

  // ── Insurance ──
  "Arena: task not in Assigned status":   "Task must be in Assigned status for insurance operations.",
  "Arena: poster cannot insure":          "The task poster cannot offer insurance on their own task.",
  "Arena: agent cannot self-insure":      "An agent cannot purchase insurance on their own task.",
  "Arena: invalid coverage":              "Coverage basis points must be between 1 and 10000.",
  "Arena: policy already exists":         "An insurance policy already exists for this task.",
  "Arena: premium below minimum":         "Insurance premium is below the minimum required.",
  "Arena: zero coverage":                 "Coverage amount calculates to zero.",
  "Arena: zero premium":                  "Premium amount calculates to zero.",
  "Arena: not the insurer":               "Only the insurer can perform this action.",
  "Arena: offer not open":                "This insurance offer is not open.",
  "Arena: not the assigned agent":        "Only the assigned agent can purchase insurance.",
  "Arena: offer not for this task":       "This insurance offer is not for the specified task.",
  "Arena: no policy for task":            "No insurance policy exists for this task.",
  "Arena: policy not active":             "The insurance policy is not active.",
  "Arena: not the insured agent":         "Only the insured agent can make this claim.",
  "Arena: task not failed":               "Task must be in Failed status to claim insurance.",
  "Arena: no slash recorded":             "No slash amount was recorded for this task.",
  "Arena: bond not slashed yet":          "The slash bond has not been processed yet.",
  "Arena: no bond slash recorded":        "No bond slash amount was recorded.",

  // ── Syndicates ──
  "Arena: name required":                 "Syndicate name is required.",
  "Arena: contribution must be > 0":      "Syndicate contribution must be greater than zero.",
  "Arena: already in a syndicate":        "You are already a member of a syndicate.",
  "Arena: syndicate not active":          "This syndicate is not active.",
  "Arena: syndicate full":                "This syndicate has reached maximum membership.",
  "Arena: not a member":                  "You are not a member of this syndicate.",
  "Arena: syndicate has active tasks":    "Cannot leave or dissolve a syndicate with active tasks.",
  "Arena: not manager":                   "Only the syndicate manager can perform this action.",
  "Arena: already dissolved":             "This syndicate has already been dissolved.",
  "Arena: need min 2 members":            "Syndicate needs at least 2 members to bid.",
  "Arena: syndicate member is poster":    "A syndicate member cannot be the task poster.",
  "Arena: syndicate mismatch":            "Task syndicate does not match the specified syndicate.",
  "Arena: stake exceeds pool":            "Requested stake exceeds the syndicate total stake.",
  "Arena: not a syndicate task":          "This task was not assigned to a syndicate.",
  "Arena: already distributed":           "Rewards have already been distributed for this task.",
  "Arena: no payout to distribute":       "No payout available to distribute.",
  "Arena: no contributions":              "No syndicate contributions found.",
  "Arena: losses already distributed":    "Losses have already been distributed for this task.",

  // ── Delegation ──
  "Arena: amount must be > 0":            "Delegation amount must be greater than zero.",
  "Arena: cannot delegate to self":       "You cannot delegate stake to yourself.",
  "Arena: no delegation pool":            "This agent has not opened a delegation pool.",
  "Arena: pool not accepting delegations":"This delegation pool is not currently accepting new delegations.",
  "Arena: max delegators reached":        "Maximum number of delegators has been reached for this pool.",
  "Arena: insufficient contribution":     "Insufficient delegated contribution for this withdrawal.",
  "Arena: capital locked in active tasks":"Delegated capital is locked in active tasks and cannot be withdrawn.",
  "Arena: no delegated stake":            "No delegated stake specified.",
  "Arena: syndicate task":                "Delegated bids cannot be placed on syndicate tasks.",
  "Arena: exceeds available delegated":   "Delegated stake exceeds available pool balance.",
  "Arena: task not settled":              "Task must be settled before claiming delegator rewards.",
  "Arena: already claimed":               "Delegator rewards have already been claimed for this task.",
  "Arena: not a delegator":               "You are not a delegator for this agent.",

  // ── Reputation NFT ──
  "Arena: invalid agent address":         "Agent address cannot be the zero address.",
  "Arena: agent already has reputation NFT": "This agent already has a reputation NFT.",
  "Arena: agent has no reputation NFT":   "This agent does not have a reputation NFT.",

  // ── Chain Routing ──
  "Arena: speed priority 1-10":           "Speed priority must be between 1 and 10.",
  "Arena: security priority 1-10":        "Security priority must be between 1 and 10.",
  "Arena: cost priority 1-10":            "Cost priority must be between 1 and 10.",
  "Arena: low must be < high":            "Low threshold must be less than high threshold.",
  "Arena: deadline threshold must be > 0":"Deadline threshold must be greater than zero.",

  // ── Protocol Self-Dogfooding ──
  "Arena: already registered for this role": "You are already registered as a protocol agent for this role.",
  "Arena: not registered for this role":  "You are not registered as a protocol agent for this role.",
  "Arena: agent not active in this role": "This agent is not active in the specified protocol role.",
  "Arena: no stake to slash":             "This protocol agent has no stake to slash.",
  "Arena: reward must be > 0":            "Reward amount must be greater than zero.",
  "Arena: insufficient treasury":         "Insufficient protocol treasury balance.",

  // ── Wallet / Provider Errors ──
  "User rejected the request":            "Transaction rejected in wallet.",
  "User denied transaction":              "Transaction rejected in wallet.",
  "user rejected transaction":            "Transaction rejected in wallet.",
  "ACTION_REJECTED":                      "Transaction rejected in wallet.",
};

function parseError(error) {
  if (!error) return null;
  const msg = error.shortMessage || error.message || String(error);

  // Check all Arena revert messages
  for (const [key, friendly] of Object.entries(REVERT_MESSAGES)) {
    if (msg.includes(key)) return friendly;
  }

  // Token / balance errors
  if (msg.includes("insufficient funds"))    return "Insufficient ETH for gas fees.";
  if (msg.includes("exceeds allowance"))     return "Token allowance too low. The approval transaction may have failed.";
  if (msg.includes("transfer amount exceeds balance")) return "Insufficient USDC balance for this operation.";
  if (msg.includes("ERC20: insufficient"))   return "Insufficient token balance.";
  if (msg.includes("ERC20: transfer"))       return "Token transfer failed. Check your balance and allowance.";
  if (msg.includes("UNPREDICTABLE_GAS"))     return "Transaction will likely fail. Check inputs and contract state.";
  if (msg.includes("nonce too"))             return "Transaction nonce error. Try resetting your wallet or wait for pending transactions.";
  if (msg.includes("replacement fee"))       return "Gas price too low. Increase gas and retry.";
  if (msg.includes("transaction underpriced")) return "Transaction underpriced. Increase gas price.";

  // Network errors
  if (msg.includes("network changed"))       return "Network changed during transaction. Please retry.";
  if (msg.includes("could not detect network")) return "Unable to detect network. Check your RPC connection.";
  if (msg.includes("timeout"))               return "Transaction timed out. The network may be congested.";
  if (msg.includes("NETWORK_ERROR"))         return "Network error. Check your connection and try again.";
  if (msg.includes("SERVER_ERROR"))          return "RPC server error. Try again in a moment.";
  if (msg.includes("CALL_EXCEPTION"))        return "Contract call failed. The contract may not be deployed on this network.";

  // Truncate long unknown errors
  if (msg.length > 160) return msg.slice(0, 160) + "...";
  return msg;
}

// ═══════════════════════════════════════════════════
// TOAST NOTIFICATION SYSTEM
// ═══════════════════════════════════════════════════

let toastId = 0;

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, maxWidth: 420, width: "100%" }}>
      {toasts.map(t => (
        <div key={t.id} onClick={() => onDismiss(t.id)} style={{
          padding: "14px 18px",
          background: t.type === "error" ? "#1a0808" : t.type === "success" ? "#081a0d" : t.type === "warning" ? "#1a1408" : "#0c0d11",
          border: `1px solid ${t.type === "error" ? "rgba(201,56,58,0.3)" : t.type === "success" ? "rgba(40,153,90,0.3)" : t.type === "warning" ? "rgba(217,152,46,0.3)" : "rgba(217,152,46,0.2)"}`,
          color: t.type === "error" ? "#e06060" : t.type === "success" ? "#28995a" : t.type === "warning" ? "#d9982e" : "#d9982e",
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 12,
          cursor: "pointer",
          animation: "slideIn 0.2s ease-out",
          lineHeight: 1.5,
          position: "relative",
          overflow: "hidden",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{
              fontWeight: 600, textTransform: "uppercase", fontSize: 10, letterSpacing: "1px",
            }}>
              {t.type === "error" ? "Error" : t.type === "success" ? "Confirmed" : t.type === "warning" ? "Warning" : "Pending"}
            </span>
            {t.type === "info" && (
              <span style={{ display: "inline-block", width: 8, height: 8, border: "2px solid #d9982e", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            )}
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.5 }}>{t.message}</div>
          {t.hash && (
            <div style={{ fontSize: 10, color: "#555868", marginTop: 6, fontFamily: "'IBM Plex Mono', monospace" }}>
              tx: {t.hash.slice(0, 10)}...{t.hash.slice(-6)}
            </div>
          )}
          {/* Auto-dismiss progress bar */}
          <div style={{
            position: "absolute", bottom: 0, left: 0, right: 0, height: 2,
            background: t.type === "error" ? "rgba(201,56,58,0.4)" : t.type === "success" ? "rgba(40,153,90,0.4)" : "rgba(217,152,46,0.3)",
            animation: `shrink ${t.type === "error" ? "8" : "5"}s linear forwards`,
            transformOrigin: "left",
          }} />
        </div>
      ))}
    </div>
  );
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const addToast = useCallback((message, type = "info", hash = null) => {
    const id = ++toastId;
    setToasts(prev => [...prev, { id, message, type, hash }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === "error" ? 8000 : 5000);
    return id;
  }, []);
  const updateToast = useCallback((id, message, type, hash) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, message, type, hash: hash || t.hash } : t));
  }, []);
  const dismiss = useCallback((id) => setToasts(prev => prev.filter(t => t.id !== id)), []);
  return { toasts, addToast, updateToast, dismiss };
}

// ═══════════════════════════════════════════════════
// CONSTANTS & STYLING
// ═══════════════════════════════════════════════════

const STATUS_COLORS = {
  open:       { bg: "rgba(66, 130, 212, 0.1)",  border: "rgba(66, 130, 212, 0.25)",  text: "#4282d4" },
  bid_reveal: { bg: "rgba(217, 152, 46, 0.1)",  border: "rgba(217, 152, 46, 0.25)",  text: "#d9982e" },
  assigned:   { bg: "rgba(217, 152, 46, 0.1)",  border: "rgba(217, 152, 46, 0.25)",  text: "#d9982e" },
  delivered:  { bg: "rgba(100, 160, 220, 0.1)", border: "rgba(100, 160, 220, 0.25)", text: "#64a0dc" },
  verifying:  { bg: "rgba(140, 120, 210, 0.1)", border: "rgba(140, 120, 210, 0.25)", text: "#8c78d2" },
  completed:  { bg: "rgba(40, 153, 90, 0.1)",   border: "rgba(40, 153, 90, 0.25)",   text: "#28995a" },
  failed:     { bg: "rgba(201, 56, 58, 0.1)",   border: "rgba(201, 56, 58, 0.25)",   text: "#c9383a" },
  disputed:   { bg: "rgba(201, 56, 58, 0.1)",   border: "rgba(201, 56, 58, 0.15)",   text: "#e06060" },
  cancelled:  { bg: "rgba(85, 88, 104, 0.1)",   border: "rgba(85, 88, 104, 0.25)",   text: "#555868" },
};

const TASK_TYPE_LABELS = {
  audit: "Smart Contract Audit",
  risk_validation: "Risk Validation",
  credit_scoring: "Credit Scoring",
  liquidation_monitoring: "Liquidation Monitor",
  treasury_execution: "Treasury Execution",
  compliance_screening: "Compliance",
  oracle_verification: "Oracle Verification",
  custom: "Custom",
};

const TASK_TYPE_OPTIONS = ["audit", "risk_validation", "credit_scoring", "treasury_execution", "compliance_screening", "oracle_verification"];

// ═══════════════════════════════════════════════════
// STRUCTURED CRITERIA TEMPLATES
// ═══════════════════════════════════════════════════

const CRITERIA_SCHEMAS = {
  audit: {
    fields: [
      { key: "contractAddress", label: "Contract Address", type: "text", placeholder: "0x...", required: true },
      { key: "chainId", label: "Chain", type: "select", options: [
        { value: "1", label: "Ethereum" }, { value: "8453", label: "Base" },
        { value: "42161", label: "Arbitrum" }, { value: "10", label: "Optimism" },
        { value: "137", label: "Polygon" }, { value: "43114", label: "Avalanche" },
      ], required: true },
      { key: "vulnerabilityCategories", label: "Vulnerability Categories", type: "checkboxes", options: [
        "reentrancy", "access_control", "oracle_manipulation", "integer_overflow",
        "flash_loan", "front_running", "logic_errors", "gas_optimization",
      ], required: true },
      { key: "severityThreshold", label: "Minimum Severity to Report", type: "select", options: [
        { value: "informational", label: "Informational" }, { value: "low", label: "Low" },
        { value: "medium", label: "Medium" }, { value: "high", label: "High" },
        { value: "critical", label: "Critical" },
      ], required: true },
      { key: "outputFormat", label: "Output Format", type: "select", options: [
        { value: "markdown_report", label: "Markdown Report" },
        { value: "json_findings", label: "JSON Findings" },
        { value: "pdf_report", label: "PDF Report" },
      ], required: true },
      { key: "slashCondition", label: "Slash Condition", type: "template",
        template: "If a {severityThreshold} or higher vulnerability is missed and exploited within the slash window",
        editable: true },
    ],
  },
  risk_validation: {
    fields: [
      { key: "positionDetails", label: "Position Details", type: "textarea", placeholder: "Describe the DeFi position, protocol, and asset details...", required: true },
      { key: "scoringRangeMin", label: "Score Range Min", type: "number", placeholder: "0", required: true },
      { key: "scoringRangeMax", label: "Score Range Max", type: "number", placeholder: "100", required: true },
      { key: "validationWindow", label: "Validation Window", type: "text", placeholder: "24h", required: true },
      { key: "lossThreshold", label: "Loss Threshold (%)", type: "number", placeholder: "5", required: true },
      { key: "slashCondition", label: "Slash Condition", type: "template",
        template: "If realized loss exceeds {lossThreshold}% within {validationWindow} of score submission",
        editable: true },
    ],
  },
  credit_scoring: {
    fields: [
      { key: "borrowerAddress", label: "Borrower Address", type: "text", placeholder: "0x...", required: true },
      { key: "scoringRangeMin", label: "Score Range Min", type: "number", placeholder: "300", required: true },
      { key: "scoringRangeMax", label: "Score Range Max", type: "number", placeholder: "850", required: true },
      { key: "defaultWindow", label: "Default Window", type: "text", placeholder: "30d", required: true },
      { key: "scoreThreshold", label: "Score Threshold", type: "number", placeholder: "650", required: true },
      { key: "slashCondition", label: "Slash Condition", type: "template",
        template: "If borrower defaults within {defaultWindow} and score was above {scoreThreshold}",
        editable: true },
    ],
  },
};

const VULN_LABELS = {
  reentrancy: "Reentrancy",
  access_control: "Access Control",
  oracle_manipulation: "Oracle Manipulation",
  integer_overflow: "Integer Overflow",
  flash_loan: "Flash Loan",
  front_running: "Front-Running",
  logic_errors: "Logic Errors",
  gas_optimization: "Gas Optimization",
};

// ═══════════════════════════════════════════════════
// OUTPUT SCHEMAS (required JSON structure per task type)
// ═══════════════════════════════════════════════════

const OUTPUT_SCHEMAS = {
  audit: {
    type: "object",
    required: ["findings", "summary", "timestamp"],
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["severity", "vulnerability_type", "location", "description", "proof_of_concept", "recommendation"],
          properties: {
            severity: { type: "string", enum: ["informational", "low", "medium", "high", "critical"] },
            vulnerability_type: { type: "string", enum: [
              "reentrancy", "access_control", "oracle_manipulation", "integer_overflow",
              "flash_loan", "front_running", "logic_errors", "gas_optimization"
            ]},
            location: { type: "string" },
            description: { type: "string" },
            proof_of_concept: { type: "string" },
            recommendation: { type: "string" },
          },
        },
      },
      summary: { type: "string" },
      timestamp: { type: "number" },
    },
  },
  risk_validation: {
    type: "object",
    required: ["score", "confidence", "factors", "timestamp"],
    properties: {
      score: { type: "number", min: 0, max: 100 },
      confidence: { type: "number", min: 0, max: 1 },
      factors: { type: "array", items: { type: "string" } },
      timestamp: { type: "number" },
    },
  },
  credit_scoring: {
    type: "object",
    required: ["default_probability", "confidence", "factors", "timestamp"],
    properties: {
      default_probability: { type: "number", min: 0, max: 1 },
      confidence: { type: "number", min: 0, max: 1 },
      factors: { type: "array", items: { type: "string" } },
      timestamp: { type: "number" },
    },
  },
  treasury_execution: {
    type: "object",
    required: ["executed_trades", "actual_slippage", "actual_mev_loss", "final_allocation"],
    properties: {
      executed_trades: {
        type: "array",
        items: {
          type: "object",
          required: ["pair", "side", "amount", "price", "timestamp"],
          properties: {
            pair: { type: "string" },
            side: { type: "string", enum: ["buy", "sell"] },
            amount: { type: "number" },
            price: { type: "number" },
            timestamp: { type: "number" },
          },
        },
      },
      actual_slippage: { type: "number" },
      actual_mev_loss: { type: "number" },
      final_allocation: { type: "object" },
    },
  },
};

// ═══════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════

function StatusBadge({ status }) {
  const colors = STATUS_COLORS[status] || STATUS_COLORS.open;
  return (
    <span style={{
      display: "inline-block", padding: "3px 10px", fontSize: 10, fontWeight: 600,
      fontFamily: "'IBM Plex Mono', monospace", letterSpacing: "1px", textTransform: "uppercase",
      color: colors.text, background: colors.bg, border: `1px solid ${colors.border}`,
    }}>
      {status.replace("_", " ")}
    </span>
  );
}

function StatCard({ label, value, sub, accent, loading }) {
  return (
    <div style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: "20px 22px", flex: 1, minWidth: 140 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#555868", marginBottom: 10 }}>{label}</div>
      {loading ? (
        <LoadingSkeleton height={28} width="50%" />
      ) : (
        <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: accent ? "#d9982e" : "#e4e4ec", lineHeight: 1 }}>{value}</div>
      )}
      {sub && !loading && <div style={{ fontSize: 11, color: "#555868", marginTop: 6 }}>{sub}</div>}
      {loading && <div style={{ marginTop: 6 }}><LoadingSkeleton height={11} width="70%" /></div>}
    </div>
  );
}

function LoadingSkeleton({ width = "100%", height = 16 }) {
  return <div style={{ width, height, background: "linear-gradient(90deg, #111318 25%, #1a1b22 50%, #111318 75%)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: 2 }} />;
}

function SkeletonTaskRow() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 120px 100px 90px 80px 90px", alignItems: "center", padding: "14px 20px", borderBottom: "1px solid #1e2028", gap: 8 }}>
      <LoadingSkeleton height={14} width="40px" />
      <div>
        <LoadingSkeleton height={13} width="70%" />
        <div style={{ marginTop: 6 }}><LoadingSkeleton height={11} width="40%" /></div>
      </div>
      <LoadingSkeleton height={14} width="80px" />
      <LoadingSkeleton height={14} width="70px" />
      <LoadingSkeleton height={14} width="50px" />
      <LoadingSkeleton height={14} width="40px" />
      <LoadingSkeleton height={20} width="70px" />
    </div>
  );
}

function SkeletonStatCards({ count = 6 }) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "24px 0", flexWrap: "wrap" }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: "20px 22px", flex: 1, minWidth: 140 }}>
          <LoadingSkeleton height={10} width="60%" />
          <div style={{ marginTop: 12 }}><LoadingSkeleton height={28} width="45%" /></div>
          <div style={{ marginTop: 8 }}><LoadingSkeleton height={11} width="70%" /></div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, subtitle }) {
  return (
    <div style={{ padding: "60px 0", textAlign: "center" }}>
      <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.3 }}>{icon}</div>
      <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 20, color: "#e4e4ec", marginBottom: 8 }}>{title}</div>
      <div style={{ fontSize: 13, color: "#555868", maxWidth: 360, margin: "0 auto", lineHeight: 1.6 }}>{subtitle}</div>
    </div>
  );
}

function Spinner({ size = 12, color = "#d9982e" }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: `2px solid ${color}`, borderTopColor: "transparent",
      borderRadius: "50%", animation: "spin 1s linear infinite",
    }} />
  );
}

function TransactionStatus({ step, stepMessages, isSubmitting, hash }) {
  const msg = stepMessages[step];
  if (step === 'idle' || !msg) return null;
  const isError = step === 'error';
  const isSuccess = step === 'done' || step === 'committed' || step === 'revealed';
  return (
    <div style={{
      marginTop: 14, padding: "12px 16px",
      background: isError ? "rgba(201, 56, 58, 0.08)" : isSuccess ? "rgba(40, 153, 90, 0.08)" : "rgba(217, 152, 46, 0.08)",
      border: `1px solid ${isError ? "rgba(201, 56, 58, 0.2)" : isSuccess ? "rgba(40, 153, 90, 0.2)" : "rgba(217, 152, 46, 0.2)"}`,
    }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: msg.color, display: "flex", alignItems: "center", gap: 8 }}>
        {isSubmitting && <Spinner size={10} color={msg.color} />}
        {isSuccess && <span style={{ color: "#28995a", fontSize: 14 }}>&#10003;</span>}
        {isError && <span style={{ color: "#c9383a", fontSize: 14 }}>&#10007;</span>}
        {msg.text}
      </div>
      {hash && (
        <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#555868", marginTop: 6 }}>
          tx: {hash.slice(0, 10)}...{hash.slice(-6)}
        </div>
      )}
    </div>
  );
}

function ConnectionWarning() {
  return (
    <div style={{
      padding: "10px 18px",
      background: "rgba(201, 56, 58, 0.06)",
      border: "1px solid rgba(201, 56, 58, 0.15)",
      fontFamily: "'IBM Plex Mono', monospace",
      fontSize: 11,
      color: "#e06060",
      display: "flex",
      alignItems: "center",
      gap: 8,
    }}>
      <span style={{ color: "#c9383a", fontSize: 14 }}>&#9888;</span>
      Unable to reach the Arena contracts. Verify the contract is deployed on this network and your RPC is connected.
    </div>
  );
}

// ═══════════════════════════════════════════════════
// TASK ROW
// ═══════════════════════════════════════════════════

function TaskRow({ task, onClick }) {
  const timeLeft = task.deadline - Date.now();
  const timeStr = timeLeft > 0
    ? timeLeft > 86400000
      ? `${Math.floor(timeLeft / 86400000)}d ${Math.floor((timeLeft % 86400000) / 3600000)}h`
      : timeLeft > 3600000
        ? `${Math.floor(timeLeft / 3600000)}h ${Math.floor((timeLeft % 3600000) / 60000)}m`
        : `${Math.floor(timeLeft / 60000)}m`
    : "Expired";

  return (
    <div onClick={() => onClick(task)} style={{
      display: "grid", gridTemplateColumns: "60px 1fr 120px 100px 90px 80px 90px",
      alignItems: "center", padding: "14px 20px", borderBottom: "1px solid #1e2028",
      cursor: "pointer", transition: "background 0.15s", fontSize: 13, color: "#9496a5",
    }}
      onMouseEnter={(e) => e.currentTarget.style.background = "#0f1014"}
      onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
    >
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#555868" }}>{task.id}</span>
      <div>
        <div style={{ color: "#e4e4ec", fontWeight: 500, fontSize: 13, marginBottom: 2 }}>{TASK_TYPE_LABELS[task.type] || task.type}</div>
        <div style={{ fontSize: 11, color: "#555868" }}>by {task.poster}</div>
      </div>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#d9982e", fontWeight: 600 }}>{Number(task.bounty).toLocaleString()} USDC</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{task.agent || "\u2014"}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: timeLeft > 0 ? "#9496a5" : "#c9383a" }}>{timeStr}</span>
      <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{task.bids} bids</span>
      <StatusBadge status={task.status} />
    </div>
  );
}

// ═══════════════════════════════════════════════════
// BID FORM
// ═══════════════════════════════════════════════════

function BidForm({ task, addToast }) {
  const { isConnected } = useAccount();
  const { commitBid, revealBid, getStoredBid, step, setStep, isPending, isConfirming, error, hash } = useBidFlow();
  const [bidForm, setBidForm] = useState({ stake: "", price: "", eta: "1h" });
  const [criteriaAcknowledged, setCriteriaAcknowledged] = useState(false);
  const [countdown, setCountdown] = useState("");
  const storedBid = getStoredBid(task._numericId);

  // Show toast on error
  useEffect(() => {
    if (error && step === 'error') addToast(parseError(error), "error");
  }, [error, step]);

  // Show toast on success
  useEffect(() => {
    if (step === 'committed') addToast("Bid committed on-chain. Wait for the reveal period to open.", "success", hash);
  }, [step]);

  useEffect(() => {
    if (step === 'revealed') addToast("Bid revealed successfully. Waiting for auction resolution.", "success", hash);
  }, [step]);

  // Countdown timer
  useEffect(() => {
    if (!task.bidDeadline) return;
    const bidDeadlineMs = task.bidDeadline * 1000;
    const revealDeadlineMs = task.revealDeadline ? task.revealDeadline * 1000 : 0;
    const update = () => {
      const now = Date.now();
      if (now < bidDeadlineMs) {
        const r = bidDeadlineMs - now;
        setCountdown(`Bid period closes in ${Math.floor(r / 60000)}m ${Math.floor((r % 60000) / 1000)}s`);
      } else if (revealDeadlineMs && now < revealDeadlineMs) {
        const r = revealDeadlineMs - now;
        setCountdown(`Reveal period closes in ${Math.floor(r / 60000)}m ${Math.floor((r % 60000) / 1000)}s`);
      } else {
        setCountdown("Period ended");
      }
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [task.bidDeadline, task.revealDeadline]);

  const isOpen = task.status === "open";
  const isBidReveal = task.status === "bid_reveal";
  const isSubmitting = isPending || isConfirming;

  const handleCommit = () => {
    if (!bidForm.stake || !bidForm.price) return;
    if (!criteriaAcknowledged) { addToast("You must acknowledge the acceptance criteria before bidding.", "error"); return; }
    // Client-side validation
    const bounty = parseFloat(task.bounty);
    const stake = parseFloat(bidForm.stake);
    const price = parseFloat(bidForm.price);
    if (isNaN(stake) || stake <= 0) { addToast("Stake must be a positive number.", "error"); return; }
    if (isNaN(price) || price <= 0) { addToast("Price must be a positive number.", "error"); return; }
    if (stake < bounty / 10) { addToast(`Stake must be at least ${(bounty / 10).toLocaleString()} USDC (10% of bounty).`, "warning"); return; }
    if (price > bounty) { addToast("Price cannot exceed the task bounty.", "error"); return; }
    commitBid({ taskId: task._numericId, stake: bidForm.stake, price: bidForm.price, eta: bidForm.eta, criteriaAckHash: task.criteriaHash });
    addToast("Submitting sealed bid...", "info");
  };

  const handleReveal = () => {
    revealBid(task._numericId);
    addToast("Approving stake + revealing bid...", "info");
  };

  const stepMessages = {
    approving:  { text: "Step 1/2 — Approving USDC stake spend...", color: "#d9982e" },
    committing: { text: "Submitting sealed bid commitment...", color: "#d9982e" },
    committed:  { text: "Bid committed on-chain. Wait for reveal period.", color: "#28995a" },
    revealing:  { text: "Step 2/2 — Revealing bid on-chain...", color: "#d9982e" },
    revealed:   { text: "Bid revealed successfully.", color: "#28995a" },
    error:      { text: parseError(error) || "Transaction failed. Check inputs and retry.", color: "#c9383a" },
  };

  if (!isConnected) {
    return (
      <div style={{ marginTop: 16, padding: "14px 18px", background: "rgba(217, 152, 46, 0.06)", border: "1px solid rgba(217, 152, 46, 0.12)", fontSize: 12, color: "#d9982e", fontFamily: "'IBM Plex Mono', monospace" }}>
        Connect wallet to place a bid
      </div>
    );
  }

  return (
    <div style={{ marginTop: 20, borderTop: "1px solid #1e2028", paddingTop: 16 }}>
      {task.criteriaHash && <CriteriaView criteriaHash={task.criteriaHash} />}
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#d9982e", marginBottom: 14, marginTop: task.criteriaHash ? 16 : 0 }}>
        {storedBid && !storedBid.revealed ? "Your Bid" : "Place a Bid"}
      </div>
      {countdown && (
        <div style={{ padding: "8px 12px", background: "rgba(217, 152, 46, 0.06)", border: "1px solid rgba(217, 152, 46, 0.12)", fontSize: 11, color: "#d9982e", fontFamily: "'IBM Plex Mono', monospace", marginBottom: 14 }}>{countdown}</div>
      )}
      {storedBid && (
        <div style={{ padding: "12px 14px", background: "rgba(40, 153, 90, 0.06)", border: "1px solid rgba(40, 153, 90, 0.15)", marginBottom: 14, fontSize: 12 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#28995a", marginBottom: 8 }}>
            {storedBid.revealed ? "Bid Revealed" : "Bid Committed"}
          </div>
          <div style={{ display: "flex", gap: 16, color: "#9496a5", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>
            <span>Stake: {storedBid.stake} USDC</span>
            <span>Price: {storedBid.price} USDC</span>
            <span>ETA: {storedBid.eta}</span>
          </div>
        </div>
      )}
      {storedBid && !storedBid.revealed && isBidReveal && (
        <button onClick={handleReveal} disabled={isSubmitting} style={{
          background: isSubmitting ? "#555868" : "#d9982e", color: "#06070a", border: "none",
          padding: "10px 24px", fontSize: 12, fontWeight: 700, cursor: isSubmitting ? "not-allowed" : "pointer",
          fontFamily: "'DM Sans', sans-serif", width: "100%", opacity: isSubmitting ? 0.7 : 1,
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
        }}>
          {isSubmitting && <Spinner size={10} color="#06070a" />}
          {isSubmitting ? "Processing..." : "Reveal Bid"}
        </button>
      )}
      {isOpen && !storedBid && (
        <>
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            {[
              { key: "stake", label: "Stake (USDC)", placeholder: "500" },
              { key: "price", label: "Price (USDC)", placeholder: "2000" },
              { key: "eta", label: "ETA", placeholder: "1h" },
            ].map(f => (
              <div key={f.key} style={{ flex: 1 }}>
                <label style={{ display: "block", fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#555868", marginBottom: 6 }}>{f.label}</label>
                <input type="text" value={bidForm[f.key]} onChange={e => setBidForm(prev => ({ ...prev, [f.key]: e.target.value }))} placeholder={f.placeholder}
                  style={{ width: "100%", background: "#111318", border: "1px solid #1e2028", color: "#e4e4ec", padding: "8px 10px", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box" }} />
              </div>
            ))}
          </div>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 12, cursor: "pointer", userSelect: "none" }}>
            <input type="checkbox" checked={criteriaAcknowledged} onChange={e => setCriteriaAcknowledged(e.target.checked)}
              style={{ marginTop: 2, accentColor: "#d9982e", cursor: "pointer" }} />
            <span style={{ fontSize: 11, color: criteriaAcknowledged ? "#e4e4ec" : "#9496a5", fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.5 }}>
              I have read and accept the acceptance criteria for this task
            </span>
          </label>
          <button onClick={handleCommit} disabled={isSubmitting || !bidForm.stake || !bidForm.price || !criteriaAcknowledged} style={{
            background: isSubmitting || !bidForm.stake || !bidForm.price || !criteriaAcknowledged ? "#555868" : "#d9982e",
            color: "#06070a", border: "none", padding: "10px 24px", fontSize: 12, fontWeight: 700,
            cursor: isSubmitting || !bidForm.stake || !bidForm.price || !criteriaAcknowledged ? "not-allowed" : "pointer",
            fontFamily: "'DM Sans', sans-serif", width: "100%", opacity: isSubmitting ? 0.7 : 1,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          }}>
            {isSubmitting && <Spinner size={10} color="#06070a" />}
            {isSubmitting ? "Processing..." : "Submit Sealed Bid"}
          </button>
          <div style={{ fontSize: 10, color: "#555868", marginTop: 8, fontFamily: "'IBM Plex Mono', monospace", lineHeight: 1.5 }}>
            Your bid will be sealed on-chain. You must reveal it during the reveal period or forfeit.
          </div>
        </>
      )}
      <TransactionStatus step={step} stepMessages={stepMessages} isSubmitting={isSubmitting} hash={hash} />
    </div>
  );
}

// ═══════════════════════════════════════════════════
// TASK DETAIL MODAL
// ═══════════════════════════════════════════════════

function TaskDetail({ task, onClose, addToast }) {
  if (!task) return null;
  const showBidForm = task.status === "open" || task.status === "bid_reveal";

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }} onClick={onClose}>
      <div style={{ background: "#0c0d11", border: "1px solid #1e2028", maxWidth: 640, width: "100%", maxHeight: "80vh", overflow: "auto", padding: 0 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ padding: "18px 24px", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#111318" }}>
          <div>
            <div style={{ fontWeight: 600, color: "#e4e4ec", fontSize: 15, marginBottom: 4 }}>{TASK_TYPE_LABELS[task.type] || task.type}</div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#555868" }}>Task {task.id}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <StatusBadge status={task.status} />
            <button onClick={onClose} style={{ background: "none", border: "1px solid #1e2028", color: "#555868", cursor: "pointer", padding: "4px 10px", fontSize: 12 }}>{"\u2715"}</button>
          </div>
        </div>
        <div style={{ padding: "20px 24px" }}>
          {[
            ["Poster", task.poster],
            ["Bounty", `${Number(task.bounty).toLocaleString()} USDC`],
            ["Agent", task.agent || "Unassigned"],
            ["Agent Stake", task.stake ? `${Number(task.stake).toLocaleString()} USDC` : "\u2014"],
            ["Required Verifiers", task.verifiers],
            ["Verified", `${task.verified || 0} / ${task.verifiers}`],
            ["Bids Received", task.bids],
          ].map(([key, val]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #1e2028", fontSize: 13 }}>
              <span style={{ color: "#555868", fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>{key}</span>
              <span style={{ color: val === "Unassigned" || val === "\u2014" ? "#555868" : "#e4e4ec", fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }}>{val}</span>
            </div>
          ))}
          {task.criteriaHash && <CriteriaView criteriaHash={task.criteriaHash} />}
          {task.status === "failed" && (
            <div style={{ marginTop: 16, padding: "14px 18px", background: "rgba(201, 56, 58, 0.08)", border: "1px solid rgba(201, 56, 58, 0.2)" }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#c9383a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Agent Slashed</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#555868", marginTop: 6 }}>Agent stake was seized. Task bounty returned to poster.</div>
            </div>
          )}
          {task.status === "completed" && (
            <div style={{ marginTop: 16, padding: "14px 18px", background: "rgba(40, 153, 90, 0.08)", border: "1px solid rgba(40, 153, 90, 0.2)" }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#28995a", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Successfully Settled</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#555868", marginTop: 6 }}>Agent was paid. Stake returned. Protocol fee deducted.</div>
            </div>
          )}
          {task.status === "disputed" && (
            <div style={{ marginTop: 16, padding: "14px 18px", background: "rgba(201, 56, 58, 0.06)", border: "1px solid rgba(201, 56, 58, 0.15)" }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#e06060", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Under Dispute</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#555868", marginTop: 6 }}>Arbitrators are reviewing this task. Outcome pending.</div>
            </div>
          )}
          {task.status === "cancelled" && (
            <div style={{ marginTop: 16, padding: "14px 18px", background: "rgba(85, 88, 104, 0.08)", border: "1px solid rgba(85, 88, 104, 0.2)" }}>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#555868", fontWeight: 600, textTransform: "uppercase", letterSpacing: "1px" }}>Cancelled</div>
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#555868", marginTop: 6 }}>Task was cancelled by the poster. Bounty returned.</div>
            </div>
          )}
          {showBidForm && <BidForm task={task} addToast={addToast} />}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// CRITERIA FORM (structured input per task type)
// ═══════════════════════════════════════════════════

function CriteriaForm({ taskType, criteria, onChange }) {
  const schema = CRITERIA_SCHEMAS[taskType];
  const inputStyle = { width: "100%", background: "#0c0d11", border: "1px solid #1e2028", color: "#e4e4ec", padding: "10px 14px", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#555868", marginBottom: 8 };

  const updateField = (key, value) => onChange({ ...criteria, [key]: value });

  // Fallback to free-text textarea for task types without a schema
  if (!schema) {
    return (
      <div style={{ marginTop: 8 }}>
        <label style={labelStyle}>Acceptance Criteria</label>
        <textarea value={criteria.description || ""} onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Describe what constitutes successful completion..." rows={4}
          style={{ ...inputStyle, fontFamily: "'DM Sans', sans-serif", resize: "vertical" }} />
      </div>
    );
  }

  // Render the slash condition template with interpolated values
  const renderTemplate = (field) => {
    let text = field.template;
    text = text.replace(/\{(\w+)\}/g, (_, key) => {
      const val = criteria[key];
      if (val !== undefined && val !== "") return val;
      return `[${key}]`;
    });
    return text;
  };

  return (
    <div style={{ marginTop: 8 }}>
      <label style={{ ...labelStyle, color: "#d9982e", marginBottom: 16 }}>Structured Criteria</label>
      {schema.fields.map((field) => (
        <div key={field.key} style={{ marginBottom: 16 }}>
          <label style={labelStyle}>
            {field.label}
            {field.required && <span style={{ color: "#c9383a", marginLeft: 4 }}>*</span>}
          </label>

          {field.type === "text" && (
            <input type="text" value={criteria[field.key] || ""} onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder} style={inputStyle} />
          )}

          {field.type === "number" && (
            <input type="number" value={criteria[field.key] || ""} onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder} style={inputStyle} />
          )}

          {field.type === "textarea" && (
            <textarea value={criteria[field.key] || ""} onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder} rows={3}
              style={{ ...inputStyle, fontFamily: "'DM Sans', sans-serif", resize: "vertical" }} />
          )}

          {field.type === "select" && (
            <select value={criteria[field.key] || ""} onChange={(e) => updateField(field.key, e.target.value)}
              style={{ ...inputStyle, fontFamily: "'DM Sans', sans-serif" }}>
              <option value="">Select...</option>
              {field.options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}

          {field.type === "checkboxes" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {field.options.map((opt) => {
                const checked = Array.isArray(criteria[field.key]) && criteria[field.key].includes(opt);
                return (
                  <label key={opt} style={{
                    display: "flex", alignItems: "center", gap: 8, padding: "8px 12px",
                    background: checked ? "rgba(217, 152, 46, 0.08)" : "#0c0d11",
                    border: `1px solid ${checked ? "rgba(217, 152, 46, 0.3)" : "#1e2028"}`,
                    cursor: "pointer", fontSize: 12, color: checked ? "#d9982e" : "#9496a5",
                    fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
                  }}>
                    <input type="checkbox" checked={checked} onChange={() => {
                      const current = Array.isArray(criteria[field.key]) ? [...criteria[field.key]] : [];
                      if (checked) updateField(field.key, current.filter(v => v !== opt));
                      else updateField(field.key, [...current, opt]);
                    }} style={{ display: "none" }} />
                    <span style={{
                      width: 14, height: 14, border: `1px solid ${checked ? "#d9982e" : "#555868"}`,
                      background: checked ? "#d9982e" : "transparent", display: "flex",
                      alignItems: "center", justifyContent: "center", fontSize: 10, color: "#06070a",
                      flexShrink: 0,
                    }}>{checked ? "\u2713" : ""}</span>
                    {VULN_LABELS[opt] || opt}
                  </label>
                );
              })}
            </div>
          )}

          {field.type === "template" && (
            <div>
              <div style={{
                padding: "12px 14px", background: "rgba(217, 152, 46, 0.04)",
                border: "1px solid rgba(217, 152, 46, 0.12)", fontSize: 12,
                color: "#9496a5", fontFamily: "'DM Sans', sans-serif", lineHeight: 1.6,
              }}>
                {renderTemplate(field)}
              </div>
              {field.editable && (
                <input type="text" value={criteria[field.key] || ""} onChange={(e) => updateField(field.key, e.target.value)}
                  placeholder="Override with custom slash condition..."
                  style={{ ...inputStyle, marginTop: 8, fontSize: 11 }} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// CRITERIA VIEW (read-only, for agents bidding)
// ═══════════════════════════════════════════════════

function CriteriaView({ criteriaHash }) {
  const { criteria, loading, error } = useCriteriaFromIPFS(criteriaHash);

  if (loading) return (
    <div style={{ padding: "12px 14px", background: "rgba(217, 152, 46, 0.04)", border: "1px solid rgba(217, 152, 46, 0.1)", marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Spinner size={10} color="#d9982e" />
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#555868" }}>Loading criteria from IPFS...</span>
      </div>
    </div>
  );

  if (!criteria) return (
    <div style={{ padding: "12px 14px", background: "rgba(85, 88, 104, 0.06)", border: "1px solid rgba(85, 88, 104, 0.15)", marginTop: 16 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#555868", marginBottom: 6 }}>Criteria Hash</div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#9496a5", wordBreak: "break-all" }}>
        {criteriaHash || "N/A"}
      </div>
    </div>
  );

  const schema = CRITERIA_SCHEMAS[criteria.taskType];
  const kvLabelStyle = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "0.5px", textTransform: "uppercase", color: "#555868" };
  const kvValueStyle = { fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#e4e4ec" };

  // Structured view
  return (
    <div style={{ marginTop: 16, padding: "16px 18px", background: "rgba(217, 152, 46, 0.04)", border: "1px solid rgba(217, 152, 46, 0.12)" }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#d9982e", marginBottom: 14 }}>
        Acceptance Criteria
      </div>
      {schema ? schema.fields.map((field) => {
        const val = criteria[field.key];
        if (val === undefined || val === "" || val === null) return null;

        let displayVal;
        if (field.type === "checkboxes" && Array.isArray(val)) {
          displayVal = val.map(v => VULN_LABELS[v] || v).join(", ");
        } else if (field.type === "select" && field.options) {
          const opt = field.options.find(o => o.value === String(val));
          displayVal = opt ? opt.label : val;
        } else if (field.type === "template") {
          // Show the custom override or the rendered template
          if (val) {
            displayVal = val;
          } else {
            let text = field.template;
            text = text.replace(/\{(\w+)\}/g, (_, key) => criteria[key] || `[${key}]`);
            displayVal = text;
          }
        } else {
          displayVal = String(val);
        }

        return (
          <div key={field.key} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(30, 32, 40, 0.5)", gap: 16 }}>
            <span style={kvLabelStyle}>{field.label}</span>
            <span style={{ ...kvValueStyle, textAlign: "right", maxWidth: "60%", wordBreak: "break-all" }}>{displayVal}</span>
          </div>
        );
      }) : (
        // Unstructured criteria — show raw
        <div>
          {Object.entries(criteria).filter(([k]) => k !== "version" && k !== "taskType").map(([key, val]) => (
            <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid rgba(30, 32, 40, 0.5)" }}>
              <span style={kvLabelStyle}>{key}</span>
              <span style={kvValueStyle}>{typeof val === "object" ? JSON.stringify(val) : String(val)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// CREATE TASK FORM
// ═══════════════════════════════════════════════════

function CreateTaskForm({ addToast }) {
  const { isConnected } = useAccount();
  const { createTask, step, isPending, isConfirming, isSuccess, error, hash } = useCreateTask();
  const [form, setForm] = useState({ taskType: "audit", bounty: "", deadline: "4h", slashWindow: "30d", requiredVerifiers: "2", bidDuration: "1h", revealDuration: "30m", criteria: {} });

  // Reset criteria when task type changes
  useEffect(() => {
    setForm(prev => ({ ...prev, criteria: {} }));
  }, [form.taskType]);

  useEffect(() => {
    if (isSuccess && step === 'done') addToast("Task created and bounty locked in escrow.", "success", hash);
  }, [isSuccess, step]);

  useEffect(() => {
    if (error && step === 'error') addToast(parseError(error), "error");
  }, [error, step]);

  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));
  const isSubmitting = isPending || isConfirming || step === 'approving' || step === 'creating';

  const handleSubmit = () => {
    if (!isConnected) { addToast("Connect your wallet first.", "warning"); return; }
    if (!form.bounty || parseFloat(form.bounty) <= 0) { addToast("Bounty must be a positive number.", "error"); return; }
    const verifiers = parseInt(form.requiredVerifiers);
    if (isNaN(verifiers) || verifiers < 1 || verifiers > 5) { addToast("Required verifiers must be between 1 and 5.", "error"); return; }
    // Validate structured criteria
    const schema = CRITERIA_SCHEMAS[form.taskType];
    if (schema) {
      for (const field of schema.fields) {
        if (!field.required) continue;
        const val = form.criteria[field.key];
        if (field.type === "checkboxes") {
          if (!Array.isArray(val) || val.length === 0) { addToast(`Please fill in: ${field.label}`, "error"); return; }
        } else if (val === undefined || val === "" || val === null) {
          addToast(`Please fill in: ${field.label}`, "error"); return;
        }
        if (field.type === "number" && isNaN(Number(val))) { addToast(`${field.label} must be a valid number.`, "error"); return; }
        if (field.type === "text" && field.label.includes("Address") && val && (!/^0x/.test(val) || val.length !== 42)) { addToast(`${field.label} must be a valid 0x address (42 characters).`, "error"); return; }
      }
    } else {
      if (!form.criteria.description) { addToast("Please fill in: Acceptance Criteria", "error"); return; }
    }
    const criteria = { taskType: form.taskType, ...form.criteria };
    createTask({ bounty: form.bounty, deadline: form.deadline, slashWindow: form.slashWindow, bidDuration: form.bidDuration, revealDuration: form.revealDuration, requiredVerifiers: verifiers, taskType: form.taskType, criteria });
    addToast("Creating task \u2014 approve USDC spend in wallet...", "info");
  };

  const inputStyle = { width: "100%", background: "#0c0d11", border: "1px solid #1e2028", color: "#e4e4ec", padding: "10px 14px", fontSize: 13, fontFamily: "'IBM Plex Mono', monospace", outline: "none", boxSizing: "border-box" };
  const labelStyle = { display: "block", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#555868", marginBottom: 8 };

  const stepMessages = {
    approving: { text: "Step 1/2 \u2014 Approving USDC spend...", color: "#d9982e" },
    creating:  { text: "Step 2/2 \u2014 Creating task on-chain...", color: "#d9982e" },
    done:      { text: "Task created successfully. Bounty is locked in escrow.", color: "#28995a" },
    error:     { text: parseError(error) || "Transaction failed. Check inputs and retry.", color: "#c9383a" },
  };

  return (
    <div style={{ maxWidth: 560, padding: "28px 0" }}>
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, fontWeight: 400, marginBottom: 24 }}>Submit a Task</h2>
      {!isConnected && (
        <div style={{ padding: "14px 18px", background: "rgba(217, 152, 46, 0.06)", border: "1px solid rgba(217, 152, 46, 0.15)", marginBottom: 20, fontSize: 12, color: "#d9982e", fontFamily: "'IBM Plex Mono', monospace" }}>
          Connect your wallet to submit tasks on-chain
        </div>
      )}
      <div style={{ marginBottom: 16 }}>
        <label style={labelStyle}>Task Type</label>
        <select value={form.taskType} onChange={(e) => updateField("taskType", e.target.value)} style={{ ...inputStyle, fontFamily: "'DM Sans', sans-serif" }}>
          {TASK_TYPE_OPTIONS.map(o => <option key={o} value={o}>{TASK_TYPE_LABELS[o] || o}</option>)}
        </select>
      </div>
      {[
        { key: "bounty", label: "Bounty (USDC)", placeholder: "2500" },
        { key: "deadline", label: "Execution Deadline", placeholder: "4h" },
        { key: "slashWindow", label: "Slash Window", placeholder: "30d" },
        { key: "requiredVerifiers", label: "Required Verifiers (1-5)", placeholder: "2" },
        { key: "bidDuration", label: "Bid Duration", placeholder: "1h" },
        { key: "revealDuration", label: "Reveal Duration", placeholder: "30m" },
      ].map((field) => (
        <div key={field.key} style={{ marginBottom: 16 }}>
          <label style={labelStyle}>{field.label}</label>
          <input type="text" value={form[field.key]} onChange={(e) => updateField(field.key, e.target.value)} placeholder={field.placeholder} style={inputStyle} />
        </div>
      ))}
      <CriteriaForm taskType={form.taskType} criteria={form.criteria} onChange={(c) => updateField("criteria", c)} />
      <button onClick={handleSubmit} disabled={!isConnected || isSubmitting || !form.bounty} style={{
        marginTop: 24, background: !isConnected || isSubmitting || !form.bounty ? "#555868" : "#d9982e",
        color: "#06070a", border: "none", padding: "12px 32px", fontSize: 13, fontWeight: 700,
        cursor: !isConnected || isSubmitting ? "not-allowed" : "pointer", fontFamily: "'DM Sans', sans-serif",
        letterSpacing: "0.5px", width: "100%", opacity: isSubmitting ? 0.7 : 1, transition: "all 0.15s",
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
      }}>
        {isSubmitting && <Spinner size={12} color="#06070a" />}
        {isSubmitting ? "Processing..." : "Submit Task + Lock Bounty"}
      </button>
      <TransactionStatus step={step} stepMessages={stepMessages} isSubmitting={isSubmitting} hash={hash} />
      <div style={{ marginTop: 16, padding: "12px 16px", background: "rgba(217,152,46,0.06)", border: "1px solid rgba(217,152,46,0.12)", fontSize: 11, color: "#9496a5", lineHeight: 1.6 }}>
        Submitting a task will transfer the bounty amount to the Arena escrow contract. Funds are returned if the task is cancelled before agent assignment.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// MY AGENT VIEW
// ═══════════════════════════════════════════════════

function MyAgentView() {
  const { isConnected } = useAccount();
  const { profile, isLoading, error: profileError } = useAgentProfile();
  const { myTasks, isLive, loading: tasksLoading } = useMyTasks();

  if (!isConnected) return <EmptyState icon={"\uD83D\uDD10"} title="Connect Wallet" subtitle="Connect your wallet to view your agent profile, reputation, task history, and active stakes." />;

  if (isLoading) return (
    <div style={{ padding: "28px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, fontWeight: 400 }}>My Agent</h2>
        <Spinner size={14} color="#d9982e" />
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
        {[1,2,3,4,5].map(i => (
          <div key={i} style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: "20px 22px", flex: 1, minWidth: 140 }}>
            <LoadingSkeleton height={10} width="60%" />
            <div style={{ marginTop: 12 }}><LoadingSkeleton height={28} width="40%" /></div>
          </div>
        ))}
      </div>
      <LoadingSkeleton height={48} width="100%" />
      <div style={{ marginTop: 16 }}>
        <LoadingSkeleton height={12} width="30%" />
      </div>
      <div style={{ marginTop: 12 }}>
        {[1,2].map(i => (
          <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid #1e2028" }}>
            <LoadingSkeleton height={14} />
          </div>
        ))}
      </div>
    </div>
  );

  if (profileError) return (
    <div style={{ padding: "28px 0" }}>
      <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, fontWeight: 400, marginBottom: 16 }}>My Agent</h2>
      <div style={{ padding: "14px 18px", background: "rgba(201, 56, 58, 0.06)", border: "1px solid rgba(201, 56, 58, 0.15)", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#e06060" }}>
        Failed to load agent profile. {parseError(profileError)}
      </div>
    </div>
  );

  const agent = profile || { displayAddress: "\u2014", reputation: 0, completed: 0, failed: 0, activeStake: "0", banned: false, successRate: "0.0" };
  const rateNum = parseFloat(agent.successRate);
  const rateColor = rateNum >= 90 ? "#28995a" : rateNum >= 80 ? "#d9982e" : rateNum > 0 ? "#c9383a" : "#555868";
  const repColor = agent.reputation >= 800 ? "#28995a" : agent.reputation >= 500 ? "#d9982e" : agent.reputation > 0 ? "#c9383a" : "#555868";

  return (
    <div style={{ padding: "28px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <h2 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 24, fontWeight: 400 }}>My Agent</h2>
        {agent.banned && <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", padding: "3px 8px", border: "1px solid rgba(201, 56, 58, 0.3)", color: "#c9383a", background: "rgba(201, 56, 58, 0.08)" }}>Banned</span>}
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 28 }}>
        {[
          { label: "Reputation", value: agent.reputation, color: repColor },
          { label: "Completed", value: agent.completed, color: "#e4e4ec" },
          { label: "Failed", value: agent.failed, color: agent.failed > 0 ? "#c9383a" : "#e4e4ec" },
          { label: "Success Rate", value: `${agent.successRate}%`, color: rateColor },
          { label: "Active Stake", value: agent.activeStake, color: "#d9982e", sub: "USDC" },
        ].map(s => (
          <div key={s.label} style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: "20px 22px", flex: 1, minWidth: 140 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#555868", marginBottom: 10 }}>{s.label}</div>
            <div style={{ fontFamily: "'Instrument Serif', serif", fontSize: 28, color: s.color, lineHeight: 1 }}>{s.value}</div>
            {s.sub && <div style={{ fontSize: 11, color: "#555868", marginTop: 6 }}>{s.sub}</div>}
          </div>
        ))}
      </div>
      <div style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: "14px 18px", marginBottom: 28, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#555868" }}>Wallet</span>
        <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#e4e4ec" }}>{profile?.address || "\u2014"}</span>
      </div>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", color: "#555868", padding: "12px 0", display: "flex", alignItems: "center", gap: 8 }}>
        Assigned Tasks ({myTasks.length})
        {tasksLoading && <Spinner size={10} color="#555868" />}
      </div>
      {myTasks.length > 0 ? (
        <div style={{ background: "#0c0d11", border: "1px solid #1e2028" }}>
          {myTasks.map(task => (
            <div key={task.id} style={{ display: "grid", gridTemplateColumns: "60px 1fr 100px 100px 90px", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid #1e2028", fontSize: 13, color: "#9496a5" }}>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#555868" }}>{task.id}</span>
              <div>
                <div style={{ color: "#e4e4ec", fontWeight: 500, fontSize: 13 }}>{TASK_TYPE_LABELS[task.type] || task.type}</div>
                <div style={{ fontSize: 11, color: "#555868" }}>by {task.poster}</div>
              </div>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", color: "#d9982e", fontWeight: 600 }}>{Number(task.bounty).toLocaleString()} USDC</span>
              <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12 }}>{Number(task.stake).toLocaleString()} USDC</span>
              <StatusBadge status={task.status} />
            </div>
          ))}
        </div>
      ) : tasksLoading ? (
        <div style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: "16px 20px" }}>
          {[1,2].map(i => (
            <div key={i} style={{ padding: "12px 0", borderBottom: "1px solid #1e2028" }}>
              <LoadingSkeleton height={14} />
            </div>
          ))}
        </div>
      ) : (
        <div style={{ background: "#0c0d11", border: "1px solid #1e2028", padding: 40, textAlign: "center", color: "#555868", fontSize: 13 }}>
          {isLive ? "No tasks assigned to this wallet." : "Connect to a network with deployed Arena contracts."}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════

export default function ArenaDashboard() {
  const [tab, setTab] = useState("tasks");
  const [selectedTask, setSelectedTask] = useState(null);
  const [filter, setFilter] = useState("all");
  const { toasts, addToast, dismiss } = useToasts();
  const { isConnected } = useAccount();

  const { tasks: liveTasks, loading, isLive, error: taskError } = useTasks(20);
  const liveStats = useProtocolStats();
  const statsLoading = isConnected && !liveStats && !taskError;

  const tasks = liveTasks;
  const protocol = liveStats || { totalTasks: 0, activeTasks: 0, totalSettled: "0", totalSlashed: "0", protocolRevenue: "0", activeAgents: 0 };

  const filteredTasks = filter === "all" ? tasks : tasks.filter(t => t.status === filter);

  return (
    <div style={{ minHeight: "100vh", background: "#06070a", color: "#e4e4ec", fontFamily: "'DM Sans', sans-serif" }}>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes slideIn { from { transform: translateX(20px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
        @keyframes shrink { from { transform: scaleX(1); } to { transform: scaleX(0); } }
      `}</style>

      <ToastContainer toasts={toasts} onDismiss={dismiss} />

      <div style={{ position: "fixed", inset: 0, backgroundImage: "linear-gradient(rgba(217,152,46,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(217,152,46,0.015) 1px, transparent 1px)", backgroundSize: "72px 72px", pointerEvents: "none", zIndex: 0 }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 1100, margin: "0 auto", padding: "0 24px" }}>
        {/* Header */}
        <header style={{ padding: "28px 0", borderBottom: "1px solid #1e2028", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <h1 style={{ fontFamily: "'Instrument Serif', serif", fontSize: 26, fontWeight: 400, letterSpacing: "-1px" }}>
              The <em style={{ fontStyle: "italic", color: "#d9982e" }}>Arena</em>
            </h1>
            <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600, letterSpacing: "1.5px", textTransform: "uppercase", padding: "3px 8px", border: "1px solid rgba(217,152,46,0.2)", color: "#d9982e", background: "rgba(217,152,46,0.08)" }}>Testnet</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11, color: "#555868" }}>Base L2</div>
            {isLive && <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", padding: "3px 8px", border: "1px solid rgba(40, 153, 90, 0.25)", color: "#28995a", background: "rgba(40, 153, 90, 0.08)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#28995a", display: "inline-block" }} />
              Live
            </div>}
            {isConnected && !isLive && !loading && (
              <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 9, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", padding: "3px 8px", border: "1px solid rgba(201, 56, 58, 0.25)", color: "#c9383a", background: "rgba(201, 56, 58, 0.08)" }}>
                Offline
              </div>
            )}
            <ConnectButton.Custom>
              {({ account, chain, openConnectModal, openChainModal, openAccountModal, mounted }) => {
                const connected = mounted && account && chain;
                return (
                  <div {...(!mounted && { 'aria-hidden': true, style: { opacity: 0, pointerEvents: 'none', userSelect: 'none' } })}>
                    {!connected ? (
                      <button onClick={openConnectModal} style={{ background: "#d9982e", color: "#06070a", border: "none", padding: "8px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Connect Wallet</button>
                    ) : chain.unsupported ? (
                      <button onClick={openChainModal} style={{ background: "#c9383a", color: "#fff", border: "none", padding: "8px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>Wrong Network</button>
                    ) : (
                      <button onClick={openAccountModal} style={{ background: "rgba(217,152,46,0.1)", color: "#d9982e", border: "1px solid rgba(217,152,46,0.25)", padding: "8px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#28995a", display: "inline-block" }} />
                        {account.displayName}
                      </button>
                    )}
                  </div>
                );
              }}
            </ConnectButton.Custom>
          </div>
        </header>

        {/* Connection warning */}
        {isConnected && !isLive && !loading && taskError && (
          <div style={{ paddingTop: 16 }}><ConnectionWarning /></div>
        )}

        {/* Protocol Stats */}
        {statsLoading ? (
          <SkeletonStatCards count={6} />
        ) : (
          <div style={{ display: "flex", gap: 12, padding: "24px 0", flexWrap: "wrap" }}>
            <StatCard label="Total Tasks" value={protocol.totalTasks} loading={false} />
            <StatCard label="Active Now" value={protocol.activeTasks} accent loading={false} />
            <StatCard label="Total Settled" value={`$${protocol.totalSettled}`} sub="USDC paid out" loading={false} />
            <StatCard label="Total Slashed" value={`$${protocol.totalSlashed}`} sub="USDC slashed" loading={false} />
            <StatCard label="Active Agents" value={protocol.activeAgents} loading={false} />
            <StatCard label="Protocol Revenue" value={`$${protocol.protocolRevenue}`} accent loading={false} />
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #1e2028", marginBottom: 0 }}>
          {["tasks", "my-agent", "create"].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              background: "none", border: "none", borderBottom: tab === t ? "2px solid #d9982e" : "2px solid transparent",
              padding: "14px 24px", color: tab === t ? "#e4e4ec" : "#555868",
              fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, fontWeight: 600,
              letterSpacing: "1px", textTransform: "uppercase", cursor: "pointer", transition: "color 0.15s",
            }}>
              {t === "create" ? "Submit Task" : t === "my-agent" ? "My Agent" : t}
            </button>
          ))}
        </div>

        {/* Task List */}
        {tab === "tasks" && (
          <div>
            <div style={{ display: "flex", gap: 8, padding: "16px 0", flexWrap: "wrap" }}>
              {["all", "open", "assigned", "verifying", "completed", "failed"].map(f => (
                <button key={f} onClick={() => setFilter(f)} style={{
                  background: filter === f ? "rgba(217,152,46,0.1)" : "transparent",
                  border: `1px solid ${filter === f ? "rgba(217,152,46,0.25)" : "#1e2028"}`,
                  color: filter === f ? "#d9982e" : "#555868", padding: "5px 14px", fontSize: 11,
                  fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, letterSpacing: "0.5px",
                  textTransform: "uppercase", cursor: "pointer", transition: "all 0.15s",
                }}>{f}</button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "60px 1fr 120px 100px 90px 80px 90px", padding: "10px 20px", borderBottom: "1px solid #1e2028", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, fontWeight: 600, letterSpacing: "1px", textTransform: "uppercase", color: "#555868" }}>
              <span>ID</span><span>Task</span><span>Bounty</span><span>Agent</span><span>Deadline</span><span>Bids</span><span>Status</span>
            </div>
            <div style={{ background: "#0c0d11", border: "1px solid #1e2028", borderTop: "none" }}>
              {loading && tasks.length === 0 ? (
                <div>
                  {[1,2,3,4,5].map(i => <SkeletonTaskRow key={i} />)}
                </div>
              ) : filteredTasks.length > 0 ? (
                filteredTasks.map(task => <TaskRow key={task.id} task={task} onClick={setSelectedTask} />)
              ) : isConnected && isLive ? (
                <div style={{ padding: 40, textAlign: "center", color: "#555868", fontSize: 13 }}>
                  {filter === "all" ? "No tasks have been created yet." : `No tasks with status "${filter.replace("_", " ")}".`}
                </div>
              ) : (
                <EmptyState icon={"\u26A1"} title={isConnected ? "No Tasks Yet" : "Connect Wallet"} subtitle={isConnected ? "No tasks have been created on this network yet. Be the first to submit a task." : "Connect your wallet to view live task data from the Arena smart contracts."} />
              )}
            </div>
            {isLive && tasks.length > 0 && (
              <div style={{ padding: "10px 0", fontSize: 10, fontFamily: "'IBM Plex Mono', monospace", color: "#28995a", textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "#28995a", display: "inline-block" }} />
                Live on-chain data \u2014 {tasks.length} task{tasks.length !== 1 ? "s" : ""} loaded
              </div>
            )}
          </div>
        )}

        {tab === "my-agent" && <MyAgentView />}
        {tab === "create" && <CreateTaskForm addToast={addToast} />}

        <footer style={{ padding: "40px 0", textAlign: "center", fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: "#333438", letterSpacing: "2px", textTransform: "uppercase", borderTop: "1px solid #1e2028", marginTop: 40 }}>
          The Arena Protocol \u2014 Testnet v0.1
        </footer>
      </div>

      {selectedTask && <TaskDetail task={selectedTask} onClose={() => setSelectedTask(null)} addToast={addToast} />}
    </div>
  );
}
