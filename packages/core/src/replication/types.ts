import { z } from 'zod';

// Replica set members are identified by the numeric _id in the configuration. The server accepts
// ids from 0 to 255 and at most 50 members per set.
export const MAX_REPLICA_SET_MEMBERS = 50;
export const MAX_VOTING_MEMBERS = 7;
export const MAX_MEMBER_PRIORITY = 1000;
const MAX_MEMBER_ID = 255;

const NonNegativeInt = z.number().int().nonnegative();
const MemberIdSchema = z.number().int().min(0).max(MAX_MEMBER_ID);
const HostSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !/[\s/]/.test(value), {
    message: 'Hosts may not contain spaces or slashes',
  });
const PrioritySchema = z.number().min(0).max(MAX_MEMBER_PRIORITY);
const VotesSchema = z.number().int().min(0).max(1, { message: 'Votes must be 0 or 1' });
const TagsSchema = z.record(z.string(), z.string());

export const ReplicaSetMemberSchema = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  state: z.string().min(1),
  stateCode: z.number().int(),
  health: z.number(),
  uptimeSeconds: NonNegativeInt.optional(),
  optimeDate: z.iso.datetime().optional(),
  lagSeconds: z.number().nonnegative().optional(),
  syncSourceHost: z.string().optional(),
  self: z.boolean(),
  priority: PrioritySchema,
  votes: VotesSchema,
  hidden: z.boolean(),
  arbiterOnly: z.boolean(),
  buildIndexes: z.boolean(),
  secondaryDelaySecs: NonNegativeInt,
  tags: TagsSchema,
  electionDate: z.iso.datetime().optional(),
  configVersion: z.number().int().optional(),
  lastHeartbeatMessage: z.string().optional(),
});

export const ReplicaSetOplogSchema = z.object({
  firstTs: z.iso.datetime(),
  lastTs: z.iso.datetime(),
  windowSeconds: z.number().nonnegative(),
  sizeMb: z.number().nonnegative().optional(),
  usedMb: z.number().nonnegative().optional(),
});

export const ReplicaSetStatusSchema = z.object({
  setName: z.string().min(1),
  myState: z.number().int(),
  term: z.number().int().optional(),
  members: z.array(ReplicaSetMemberSchema),
  primary: z.string().optional(),
  majorityVoteCount: NonNegativeInt.optional(),
  writeMajorityCount: NonNegativeInt.optional(),
  oplog: ReplicaSetOplogSchema.optional(),
  electionCandidateMetrics: z.unknown().optional(),
});

export const ReplicaSetMemberConfigSchema = z.object({
  id: MemberIdSchema,
  host: HostSchema,
  priority: PrioritySchema,
  votes: VotesSchema,
  hidden: z.boolean(),
  arbiterOnly: z.boolean(),
  buildIndexes: z.boolean(),
  secondaryDelaySecs: NonNegativeInt,
  tags: TagsSchema,
});

export const ReplicaSetConfigSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  term: z.number().int().optional(),
  protocolVersion: z.number().int().optional(),
  writeConcernMajorityJournalDefault: z.boolean().optional(),
  members: z.array(ReplicaSetMemberConfigSchema),
  // Canonical EJSON of the settings document. Core holds no driver values, so an ObjectId such as
  // replicaSetId travels as its $oid form.
  settingsEjson: z.string(),
});

// Omitted member fields take the planner's defaults: priority 1 for a normal voting member, and
// priority 0 when the member is hidden, an arbiter, delayed, or has no votes.
export const AddMemberInputSchema = z.object({
  host: HostSchema,
  priority: PrioritySchema.optional(),
  votes: VotesSchema.optional(),
  hidden: z.boolean().optional(),
  arbiterOnly: z.boolean().optional(),
  buildIndexes: z.boolean().optional(),
  secondaryDelaySecs: NonNegativeInt.optional(),
  tags: TagsSchema.optional(),
});

export const RemoveMemberInputSchema = z.object({
  memberId: MemberIdSchema,
});

// The patch may repeat the id and host of the member. The planner refuses a patch that changes
// either one, because a rename is a remove and an add.
export const ReplicaSetMemberPatchSchema = z.object({
  id: MemberIdSchema.optional(),
  host: HostSchema.optional(),
  priority: PrioritySchema.optional(),
  votes: VotesSchema.optional(),
  hidden: z.boolean().optional(),
  arbiterOnly: z.boolean().optional(),
  buildIndexes: z.boolean().optional(),
  secondaryDelaySecs: NonNegativeInt.optional(),
  tags: TagsSchema.optional(),
});

export const UpdateMemberInputSchema = z.object({
  memberId: MemberIdSchema,
  patch: ReplicaSetMemberPatchSchema,
});

export const ReconfigChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add'), member: AddMemberInputSchema }),
  z.object({ kind: z.literal('remove'), memberId: MemberIdSchema }),
  z.object({
    kind: z.literal('update'),
    memberId: MemberIdSchema,
    patch: ReplicaSetMemberPatchSchema,
  }),
]);

export const StepDownInputSchema = z.object({
  connectionId: z.never().optional(),
  stepDownSeconds: NonNegativeInt.default(60),
  secondaryCatchUpSeconds: NonNegativeInt.optional(),
  force: z.boolean().optional(),
});

export const FreezeInputSchema = z.object({
  seconds: NonNegativeInt,
});

export const InitiateMemberInputSchema = z.object({
  host: HostSchema,
  priority: PrioritySchema.optional(),
});

export const InitiateInputSchema = z
  .object({
    setName: z.string().min(1),
    members: z.array(InitiateMemberInputSchema).min(1).max(MAX_REPLICA_SET_MEMBERS),
  })
  .refine(
    (input) => new Set(input.members.map((member) => member.host)).size === input.members.length,
    { message: 'Each host may appear only once' },
  );

export const ReconfigPlanSchema = z.object({
  current: ReplicaSetConfigSchema,
  next: ReplicaSetConfigSchema,
  changes: z.array(z.string()),
  warnings: z.array(z.string()),
  refused: z.string().optional(),
});

export type ReplicaSetMember = z.infer<typeof ReplicaSetMemberSchema>;
export type ReplicaSetOplog = z.infer<typeof ReplicaSetOplogSchema>;
export type ReplicaSetStatus = z.infer<typeof ReplicaSetStatusSchema>;
export type ReplicaSetMemberConfig = z.infer<typeof ReplicaSetMemberConfigSchema>;
export type ReplicaSetConfig = z.infer<typeof ReplicaSetConfigSchema>;
export type AddMemberInput = z.input<typeof AddMemberInputSchema>;
export type RemoveMemberInput = z.infer<typeof RemoveMemberInputSchema>;
export type ReplicaSetMemberPatch = z.infer<typeof ReplicaSetMemberPatchSchema>;
export type UpdateMemberInput = z.infer<typeof UpdateMemberInputSchema>;
export type ReconfigChange = z.infer<typeof ReconfigChangeSchema>;
export type StepDownInput = z.input<typeof StepDownInputSchema>;
export type StepDownOutput = z.output<typeof StepDownInputSchema>;
export type FreezeInput = z.infer<typeof FreezeInputSchema>;
export type InitiateMemberInput = z.infer<typeof InitiateMemberInputSchema>;
export type InitiateInput = z.infer<typeof InitiateInputSchema>;
export type ReconfigPlan = z.infer<typeof ReconfigPlanSchema>;
