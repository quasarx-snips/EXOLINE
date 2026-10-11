# EXOLINE — 16 Independent Coding-Agent Prompts

This archive contains exactly **16 independent weekly Markdown prompts + this README**.

Every weekly prompt is designed to be copied and pasted by itself into a repository-aware coding agent such as Claude Code, Codex, Cursor, Copilot, OpenCode, or similar.

## Independence guarantee

Each weekly prompt contains its own:
- EXOLINE project context
- architecture contract
- agent operating rules
- UI-first requirements
- deterministic simulation rules
- units
- relevant maths/physics
- exact weekly task
- scope boundaries
- implementation requirements
- test requirements
- browser demo requirements
- final response format

There is **no global prompt** to paste first.

## Sequence

### Month 1
- Week 1: `month01_week01_foundation_polished_ui_shell.md`
- Week 2: `month01_week02_universe_generation_economy_storage.md`
- Week 3: `month01_week03_industry_research_content_foundation.md`
- Week 4: `month01_week04_phase_1_integration_professional_demo.md`

### Month 2
- Week 5: `month02_week05_rocket_parts_native_rocket_editor.md`
- Week 6: `month02_week06_rocket_validation_staging_flight_preparation.md`
- Week 7: `month02_week07_orbit_transfer_docking_landing.md`
- Week 8: `month02_week08_phase_2_completion_flight_polish.md`

### Month 3
- Week 9: `month03_week09_base_construction_life_support.md`
- Week 10: `month03_week10_population_industry_self_sustaining_colony.md`
- Week 11: `month03_week11_storage_networks_rewards_progression.md`
- Week 12: `month03_week12_astrablock_visual_automation_phase_3_completion.md`

### Month 4
- Week 13: `month04_week13_60_system_galaxy_interstellar_expansion.md`
- Week 14: `month04_week14_civilization_levels_ai_advisor_contracts.md`
- Week 15: `month04_week15_ml_modules_final_infrastructure_continuity_core.md`
- Week 16: `month04_week16_final_release_endless_performance_qa.md`


## How to use

1. Start with Week 1.
2. Open the corresponding `.md` file.
3. Copy the entire file.
4. Paste it into the coding agent with the EXOLINE repository/worktree open.
5. Let the agent inspect the real repository before editing.
6. Let it implement and test.
7. Run the requested browser demo yourself.
8. Review the changed files.
9. Commit/tag the working week.
10. Move to the next weekly prompt.

A new agent can be used every week. The prompt is independent, but the **repository itself remains the source of truth** for what is actually implemented.

## Credit-saving strategy

The prompts intentionally provide the expensive-to-rediscover information up front:
- game context
- architecture
- formulas
- physics
- state structures
- UI rules
- deterministic behavior
- tests
- acceptance criteria

The agent is also told not to spend tokens on a long design essay. It should inspect, implement, test, fix, and report briefly.

## Agent switching

You can use different agents for different weeks.

Example:
- Week 1: Codex
- Week 2: Claude Code
- Week 3: Cursor
- Week 4: OpenCode

The incoming agent should inspect the repository rather than assuming the previous agent completed everything.

## Repair workflow

When a weekly implementation breaks, use a focused repair instruction instead of restarting the whole project.

Example:

“Inspect the current repository and fix the regression introduced by the previous changes. Preserve the existing architecture, make the smallest correct fix, run the relevant tests and build, and report only changed files, tests, build, demo, known issues, and next step.”

Then continue with the scheduled weekly prompt.

## Weekly rule

Every week must finish with something visible in the browser.

EXOLINE is intentionally UI-first. Simulation work without a usable UI/demo does not count as a completed weekly deliverable.

## Project ownership

You are the product owner.

Agents are implementation workers.

Keep final authority over:
- game design
- scope
- balancing
- visual direction
- feature acceptance
- final release decisions

## AI/ML rule

AI/ML is optional enhancement.

The required implementation sequence is:

deterministic baseline
→ model adapter
→ confidence
→ sanity checks
→ fallback
→ UI explanation

The game must remain playable with AI disabled.
