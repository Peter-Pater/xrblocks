import type {JointName} from '../../input/Hands';

export type SimulatorHandPoseJoints = {
  t: number[];
  r: number[];
  s?: number[];
}[];

export type SimulatorHandJointRotation = {
  x?: number;
  y?: number;
  z?: number;
};

export type SimulatorHandPoseRotations = Partial<
  Record<JointName, SimulatorHandJointRotation>
>;
