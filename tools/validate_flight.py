"""Numerical smoke checks for the v0.0.3 two-body RK4 model."""
import json, math
from pathlib import Path
root=Path(__file__).resolve().parents[1]
c=json.loads((root/'data/physics_constants.json').read_text()); G=c['G']; e=c['bodies']['earth']; mu=G*e['mass']; r0=e['radius_m']+180000
r=[r0,0.0]; v=[0.0,math.sqrt(mu/r0)]; energy=lambda r,v:sum(x*x for x in v)/2-mu/math.hypot(*r); e0=energy(r,v); dt=2.0
def a(q):
 d=(q[0]*q[0]+q[1]*q[1])**1.5; return [-mu*q[0]/d,-mu*q[1]/d]
def step(r,v):
 a1=a(r); r2=[r[i]+v[i]*dt/2 for i in range(2)];v2=[v[i]+a1[i]*dt/2 for i in range(2)];a2=a(r2);r3=[r[i]+v2[i]*dt/2 for i in range(2)];v3=[v[i]+a2[i]*dt/2 for i in range(2)];a3=a(r3);r4=[r[i]+v3[i]*dt for i in range(2)];v4=[v[i]+a3[i]*dt for i in range(2)];a4=a(r4)
 return [r[i]+dt*(v[i]+2*v2[i]+2*v3[i]+v4[i])/6 for i in range(2)],[v[i]+dt*(a1[i]+2*a2[i]+2*a3[i]+a4[i])/6 for i in range(2)]
for _ in range(3000): r,v=step(r,v)
assert abs((energy(r,v)-e0)/e0)<1e-8
assert e['radius_m']<math.hypot(*r)<r0*1.01
assert 7000<math.hypot(*v)<9000
print('flight validation: PASS')
