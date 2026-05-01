# Risk Context: Exception Thresholds

A composite risk score in [0, 100] determines what happens to a violation that
cannot be auto-remediated:

| Score   | Decision     | Action |
|---------|--------------|--------|
| 0–29    | auto-approve | Granted with audit trail. |
| 30–69   | review       | Ticket filed via `exception_tool` for the security team. |
| 70–100  | block        | Architecture review required. |

Composite score = weighted sum of:

- blast_radius (30%) — see `examples/risk/blast-radius.md`
- data_sensitivity (25%) — see `examples/risk/data-classification.md`
- exposure (20%) — internet/VPN/private
- temporal (15%) — duration of the exception
- compensating_controls (-10% per control, capped at -30%)
