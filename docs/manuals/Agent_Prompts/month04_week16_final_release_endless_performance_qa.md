# EXOLINE — Month 4, Week 16: Final release + endless mode + performance + QA

> COPY-PASTE THIS ENTIRE FILE INTO YOUR CODING AGENT.  
> This prompt is intentionally self-contained. Do not assume the agent has seen any other EXOLINE prompt.


You are a repository-aware coding agent working on EXOLINE, a browser-based space settlement and civilization expansion simulator. This prompt is SELF-CONTAINED. Do not require another EXOLINE prompt or external project brief to understand the task.

PROJECT NORTH STAR
The player starts on Earth in Sol, builds industry, designs rockets in a native SFS-style editor, launches missions, reaches orbit, transfers, lands/docks/floats/anchors according to body type, establishes bases, manages resources and population, automates missions with ASTRABLOCK, uses optional AI/ML assistance, expands across 60 named star systems, reaches Civilization Level 10, constructs and activates the Continuity Core, and then enters endless mode.

SOURCE-DEFINED FINAL SCALE
- 60 named star systems
- 480 named planets
- 120 named asteroids
- 80 rocket/infrastructure parts
- 14 resources
- 10 civilization levels
- 12 AI/ML modules
- 5 population cohorts
- 6 population skill groups
- ASTRABLOCK visual automation language
- four month-long development phases
The source design explicitly says AI systems are optional and deterministic fallbacks must exist. It also requires simulation level-of-detail, no per-citizen agents, no full N-body simulation for all systems, no simulation logic in the render loop, and no AI prediction blocking the main thread. fileciteturn0file0L58-L70 fileciteturn0file0L1111-L1121

ARCHITECTURE CONTRACT
Prefer this logical separation unless the existing repository already has an equivalent:
React + TypeScript UI
        ↓
typed commands / read models
        ↓
Web Worker
        ↓
Rust/WASM simulation core
        ↓
authoritative deterministic state

PixiJS handles spatial/visual rendering.
React handles panels, forms, dashboards, menus, inspectors, and application UI.
Rust/WASM or the established authoritative simulation layer owns game truth.
The render loop NEVER owns authoritative simulation.
UI NEVER directly mutates authoritative simulation state.
AI NEVER directly mutates authoritative simulation state.

If the repository already uses a reasonable equivalent architecture, preserve it instead of rewriting it.

AGENT WORK MODE
1. Inspect the repository first.
2. Reuse existing code.
3. Do not spend tokens writing a long plan.
4. Make reasonable implementation decisions without asking for confirmation unless implementation is genuinely impossible.
5. Implement first, then test, then fix.
6. Do not rewrite unrelated working modules.
7. Do not add duplicate state managers.
8. Do not introduce unnecessary dependencies.
9. Keep the app runnable.
10. Finish with a short report only.

UI-FIRST RULE
Every new feature must have a browser-visible UI representation in the same week.
Do not say “backend complete, UI later.”
Every important feature must define loading, ready, success, blocked/invalid, and error states where relevant.
Critical state must not be communicated only by color.
Important metrics need labels, units, and human-readable explanations.

DETERMINISM
Authoritative update:
state(t + Δt) = F(state(t), commands(t), seed)

Use fixed simulation steps.
Do not use render-frame duration as authoritative simulation time.
Use explicit seeded PRNG streams for generated/randomized gameplay.
Prefer deterministic iteration order.
Mission results, rewards, procedural generation, and economic calculations should be reproducible from state + commands + seed + version.

UNITS
Internal preferred units:
mass kg
distance m
time s
velocity m/s
acceleration m/s²
force N
power W
energy J
temperature K
pressure Pa
resource quantities = simulation units
rates = resource units/s or units/tick
Never mix units silently.

COMMON PHYSICS
g0 = 9.80665 m/s²

Tsiolkovsky:
Δv = Isp * g0 * ln(m0 / mf)

TWR:
TWR = T / (m * g)

Circular orbital velocity:
v_circular = sqrt(μ / r)

Orbital period:
T = 2π * sqrt(r³ / μ)

Hohmann transfer:
a_transfer = (r1 + r2) / 2
dv1 = sqrt(μ/r1) * (sqrt(2r2/(r1+r2)) - 1)
dv2 = sqrt(μ/r2) * (1 - sqrt(2r1/(r1+r2)))
dv_total = |dv1| + |dv2|
t_transfer = π * sqrt(a_transfer³ / μ)

Simplified vertical flight:
a = (T - D)/m - g
v_next = v + a*Δt
h_next = h + v*Δt

Simplified drag:
D = 0.5 * ρ * v² * Cd * A

Simple atmosphere:
ρ = ρ0 * exp(-h/H)

Simplified entry heating:
heatRate = k_heat * sqrt(max(ρ,0)) * v³
heat_next = heat + heatRate * Δt
temperature = baseTemperature + heat / heatCapacity

RESOURCE MODEL
For resource r:
next = clamp(
    current
    + production * Δt
    - consumption * Δt
    + inflow * Δt
    - outflow * Δt,
    0,
    capacity
)

netRate = production - consumption + inflow - outflow

If netRate < 0:
TTZ = current / abs(netRate)
Otherwise TTZ is not finite/displayed.

Storage:
accepted = min(requested, sourceAvailable, destinationFree)
overflow = requested - accepted

Never make resources negative.
Never exceed capacity.
Where the game specification says overflow production is lost, lost overflow must be explicit in telemetry/logs.

POPULATION
Use aggregate cohorts, never one agent per citizen.
Cohorts:
Children
Young Adults
Working Adults
Middle Adults
Elderly

Skills:
Unskilled
Technician
Engineer
Scientist
Administrator
Specialist

Population update:
nextPopulation = max(0, current + births - deaths + migrationIn - migrationOut)

Need satisfaction:
satisfaction = clamp(availableSupply / requiredDemand, 0, 1)

Effective labor:
labor = Σ cohortCount_i * workingFraction_i * skillAvailability_i * healthFactor

ROCKET COM/COТ
Center of mass:
r_COM = (Σ m_i r_i) / (Σ m_i)

Center of thrust:
r_COT = (Σ |F_i| r_i) / (Σ |F_i|)

FINAL AGENT RESPONSE
Return only:
### Changed
- files + one-line purpose

### Tests
- exact commands and pass/fail

### Build
- exact command and pass/fail

### Demo
- route/screen
- 3-8 steps

### Known Issues
- only real remaining issues

### Next
- one next recommended task


---

TASK
Finish EXOLINE Phase 4 and ship the most stable browser release possible.

EXIT
“A player can expand across all 60 systems, reach Civilization Level 10, and activate the Continuity Core.” fileciteturn0file0L1206-L1224

FINAL VICTORY PREDICATE
civilizationLevel == 10
AND all 60 systems colonized
AND all 60 systems self-sustaining
AND all systems have functional storage networks
AND all systems have functioning reward claim networks
AND all systems can produce advanced parts locally
AND Continuity Core constructed
AND Continuity Core activated

ENDLESS MODE
gameMode = ENDLESS
Do not fork the simulation into a second ruleset.
Keep:
resources
population
missions
galaxy
production
events
progress
running.

PERFORMANCE LOD
Active rocket flight: High / seconds
Active base: High / minutes
Colonized planet: Medium / hours
Same-system bodies: Medium / hours-days
Distant colonized systems: Low / days-weeks
Uncolonized systems: Minimal / weeks-months
Galactic summary: Aggregate / months-years

Do not:
simulate every citizen
full-flight all background missions
full-resolution all planets
simulation in render loop
huge allocations every frame
full N-body everywhere
full planetary tile maps everywhere
block simulation with AI
update every UI component every tick

DISTANT STATE
Use aggregate:
population
resource stock summary
production
consumption
self-sufficiency
mission counts
trade routes
risk

Hydrate detailed state when selected/needed.

SAVE ROBUSTNESS
Test:
fresh save
current save
older supported save
corrupt save
unknown schema
unknown content version

User-facing errors must explain what failed and available recovery.
Never silently wipe saves.

BROWSER QA
Fresh load
new game
navigation
economy
storage
rocket editor
mission
landing
colony
population
rewards
ASTRABLOCK
galaxy
civilization
AI
Continuity Core
endless
save
reload
load

MATH SANITY
Rocket:
Δv=Isp*g0*ln(m0/mf)
TWR=T/(m*g)
v=sqrt(μ/r)
T=2π*sqrt(r³/μ)

Resource:
next=clamp(current+netRate*Δt,0,capacity)

Population:
next=max(0,current+births-deaths+migrationIn-migrationOut)

Storage:
accepted=min(requested,sourceAvailable,destinationFree)

No normal gameplay value may become:
negative mass
negative capacity
negative population
NaN
Infinity
fuel from nowhere

FINAL DETERMINISM
Run the same complete fixture twice.
Compare:
simulation digest
mission outcome
reward outcomes
generated universe
civilization state
They must match.

SECURITY/ROBUSTNESS
Validate commands at simulation boundary.
Malformed ASTRABLOCK cannot crash the sim.
Save files cannot execute code.
UI cannot bypass progression rules.

FINAL UI PASS
Dashboard
Galaxy
System
Planet
Base
Storage
Industry
Rocket Editor
Mission Prep
Flight
Mission Report
Population
Rewards
ASTRABLOCK
Civilization
AI Center
Continuity Core

Check hierarchy, spacing, numbers, units, tooltips, focus, loading, empty, blocked, error, success states.

RELEASE
Run repository formatter
lint
typecheck
unit
integration
E2E
production build
Use actual repository commands.

FINAL DEMO
Start → Earth → galaxy → colony → rocket → automation → AI recommendation → civilization → Continuity Core → endless mode → return to galaxy.

Do not claim unfinished features are complete.
Create release tag, changelog, known limitations, architecture summary, test summary, demo route.

Ship.
