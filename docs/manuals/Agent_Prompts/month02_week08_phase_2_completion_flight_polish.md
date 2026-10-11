# EXOLINE — Month 2, Week 8: Phase 2 completion + flight polish

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
Complete Month 2 Phase 2.

EXIT
“A player can build a rocket from resources, launch, reach orbit, land on a target body, and deliver payload.” fileciteturn0file0L1162-L1182

RUN THE COMPLETE LOOP
resources → parts → blueprint → validation → launch → orbit → transfer → landing → payload → report

IMPLEMENT/VERIFY
Pre-launch validation
Countdown
Engine ignition
Stage separation
Atmospheric ascent
Gravity-turn state
Orbital insertion
Orbit stabilization
Transfer
Docking approach
Docking lock
Undocking
Deorbit
Atmospheric entry
Heat simulation
Parachute
Retro thrust
Water splashdown
Aerostat deployment
Asteroid anchoring
Crash resolution
Payload delivery
Crew transfer
Resource transfer
Mission report

HEAT
heatRate = k_heat*sqrt(max(rho,0))*v³
heat += heatRate*Δt
temperature = baseTemperature + heat/heatCapacity

FAILURE
Track:
partHealth
vehicleHealth
thermalDamage
impactDamage
resourceLoss

Avoid arbitrary random failures in normal early-game play.

LANDING SCORE
score = clamp(
100
-speedPenalty
-slopePenalty
-hazardPenalty
-fuelPenalty
-equipmentPenalty,
0,100)

Labels:
Excellent
Good
Marginal
Failed

PAYLOAD
On success:
destination receives payload
report records delivery
task hooks fire

On failure:
payload remains at origin unless mission rules explicitly mark it lost.

UI POLISH
Rocket editor:
search
attachment feedback
stats
validation
stage timeline

Flight:
state
telemetry
trajectory
fuel
delta-v margin
warnings
abort

Report:
result
timeline
resource accounting
payload accounting
failures
recommendations

Tutorial:
starter blueprint → validation → launch → orbit → transfer → landing → report

TESTS
golden successful mission
golden failure
payload delivery
heat threshold
landing score
mission state order
save/load blueprint

DEMO
Earth → build rocket → launch → orbit → transfer → land → payload delivered → mission report.

Tag Phase 2 and do not move to large colony scope until this loop works.
