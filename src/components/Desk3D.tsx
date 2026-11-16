import type React from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom, N8AO } from "@react-three/postprocessing";
import type { AgentActivity, AgentId, SignalPulse } from "../types.ts";

export interface Desk3DProps {
  activities: Record<AgentId, AgentActivity>;
  pulses: SignalPulse[];
  equity: number;
  currentPnl: number;
  dailyClosedProfit: number;
}

const AGENT_NODES: Array<{ id: AgentId; color: string; angle: number }> = [
  { id: "lead", color: "#fbbf24", angle: 0 },
  { id: "analyst", color: "#38bdf8", angle: Math.PI / 4 },
  { id: "strategist", color: "#a855f7", angle: (Math.PI * 2) / 4 },
  { id: "risk", color: "#f43f5e", angle: (Math.PI * 3) / 4 },
  { id: "execution", color: "#10b981", angle: Math.PI },
  { id: "reviewer", color: "#94a3b8", angle: (Math.PI * 5) / 4 },
  { id: "sentinel", color: "#22d3ee", angle: (Math.PI * 6) / 4 },
  { id: "hunter", color: "#f97316", angle: (Math.PI * 7) / 4 },
];

const HolographicAgentNode: React.FC<{ color: string; x: number; z: number; active: boolean }> = ({
  color,
  x,
  z,
  active,
}) => {
  useFrame(() => {
    // 60fps orbital micro-motion handled by R3F render loop
  });

  return (
    <group position={[x, 0, z]}>
      <mesh>
        <sphereGeometry args={[0.62, 36, 36]} />
        <meshPhysicalMaterial
          color={color}
          metalness={0.15}
          roughness={0.08}
          transmission={0.72}
          thickness={0.8}
          ior={1.45}
          clearcoat={1.0}
          transparent
          opacity={0.88}
        />
      </mesh>
      <mesh>
        <sphereGeometry args={[0.26, 24, 24]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={active ? 2.2 : 1.0} />
      </mesh>
      <mesh rotation={[Math.PI / 3, 0, 0]}>
        <torusGeometry args={[0.82, 0.02, 16, 48]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.8} metalness={0.85} roughness={0.15} />
      </mesh>
    </group>
  );
};

export const Desk3D: React.FC<Desk3DProps> = ({
  activities,
  pulses,
  equity,
  currentPnl,
  dailyClosedProfit,
}) => {
  return (
    <div className="relative w-full h-screen bg-[#050811] overflow-hidden">
      <Canvas camera={{ position: [0, 6.5, 11], fov: 46 }}>
        <color attach="background" args={["#050811"]} />
        <ambientLight intensity={0.35} />
        <pointLight position={[0, 6, 0]} intensity={2.2} color="#38bdf8" />
        {AGENT_NODES.map((node) => {
          const radius = 4.6;
          const x = Math.cos(node.angle) * radius;
          const z = Math.sin(node.angle) * radius;
          const act = activities?.[node.id];
          const isActive = Boolean(act && act.status !== "idle" && act.status !== "watch");
          return <HolographicAgentNode key={node.id} color={node.color} x={x} z={z} active={isActive} />;
        })}
        {(pulses || []).slice(-6).map((p) => (
          <mesh key={p.id} position={[0, 0.4, 0]}>
            <sphereGeometry args={[0.1, 12, 12]} />
            <meshBasicMaterial color="#38bdf8" />
          </mesh>
        ))}
        <EffectComposer>
          <N8AO aoRadius={0.6} intensity={1.4} />
          <Bloom mipmapBlur luminanceThreshold={0.8} intensity={1.35} />
        </EffectComposer>
      </Canvas>

      {/* MINIMAL INSTITUTIONAL HUD */}
      <div className="absolute bottom-6 left-6 z-20 flex items-center gap-6 px-5 py-3 rounded-2xl bg-neutral-950/75 backdrop-blur-xl border border-neutral-800/80 shadow-2xl">
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">Équité Totale</div>
          <div className="text-lg font-mono font-bold text-neutral-100">
            {equity.toLocaleString("fr-FR", { style: "currency", currency: "USD" })}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">PNL Actuel</div>
          <div className={`text-lg font-mono font-bold ${currentPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {currentPnl >= 0 ? "+" : ""}
            {currentPnl.toLocaleString("fr-FR", { style: "currency", currency: "USD" })}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase tracking-wider text-neutral-400">Profit Fermé de la journée</div>
          <div className={`text-lg font-mono font-bold ${dailyClosedProfit >= 0 ? "text-emerald-400" : "text-red-400"}`}>
            {dailyClosedProfit >= 0 ? "+" : ""}
            {dailyClosedProfit.toLocaleString("fr-FR", { style: "currency", currency: "USD" })}
          </div>
        </div>
      </div>
    </div>
  );
};

export default Desk3D;
