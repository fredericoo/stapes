import type { Vec3 } from "./limb-caster";
import type { LimbPoint, Pose } from "./quadruped-caster";

/** A joint as [along from under the hip or shoulder, height above the ground, radius]. */
export type Bone = [number, number, number];

export type LimbShape = { planted: Bone[]; folded: Bone[] };

/**
 * The limbs of a beast that walks upright, legs first: `roots` is where each
 * limb's top joint sits, along and across the body. A limb's shape blends
 * from planted to folded by its `lift`, then the whole limb swings about its
 * top joint by `swing`. The stride's drop squashes a leg towards the ground,
 * so a planted foot stays down while the body sinks, and carries an arm down
 * with the shoulder.
 */
export function jointedLimbs(
  roots: [number, number][],
  legs: number,
  leg: LimbShape,
  arm: LimbShape,
) {
  return (index: number, pose: Pose, drop: number): LimbPoint[] => {
    const [along, across] = roots[index]!;
    const isLeg = index < legs;
    const { planted, folded } = isLeg ? leg : arm;
    const t = pose.lift?.[index] ?? 0;
    const [rootAlong, rootUp] = planted[0]!;
    const angle = Math.atan2(pose.swing[index]!, rootUp);
    const squash = (rootUp - drop) / rootUp;
    return planted.map((bone, i) => {
      const other = folded[i]!;
      const dx = bone[0] + (other[0] - bone[0]) * t - rootAlong;
      const dz = bone[1] + (other[1] - bone[1]) * t - rootUp;
      const swungX = dx * Math.cos(angle) - dz * Math.sin(angle);
      const swungZ = dx * Math.sin(angle) + dz * Math.cos(angle);
      const up = isLeg ? (rootUp + swungZ) * squash : rootUp + swungZ - drop;
      const at: Vec3 = [along + rootAlong + swungX, across, up];
      return { at, r: bone[2], paw: i === planted.length - 1 };
    });
  };
}
