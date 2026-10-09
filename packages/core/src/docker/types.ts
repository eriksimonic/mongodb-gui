import { z } from 'zod';

/** A Docker container id or name as the Engine API accepts it. Used in URL paths, so it stays strict. */
export const DockerContainerIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'The container id is invalid.');

export const DockerContainerStateSchema = z.enum([
  'running',
  'exited',
  'paused',
  'restarting',
  'other',
]);

export const DockerPublishedPortSchema = z.object({
  hostIp: z.string().min(1),
  hostPort: z.number().int().positive(),
});

/** Credentials stay in the main process. Only the summary below reaches the renderer. */
export const DockerMongoEnvSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
  database: z.string().optional(),
});

export const DockerMongoContainerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  image: z.string().min(1),
  state: DockerContainerStateSchema,
  publishedPort: DockerPublishedPortSchema.optional(),
  internalPort: z.number().int().positive(),
  networks: z.array(z.string()),
  env: DockerMongoEnvSchema,
  /** Names of every environment variable on the container. Values never leave the main process. */
  envKeys: z.array(z.string()),
});

/** The renderer view of a container. The password is replaced by `hasCredentials`. */
export const DockerMongoContainerSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  image: z.string().min(1),
  state: DockerContainerStateSchema,
  publishedPort: DockerPublishedPortSchema.optional(),
  internalPort: z.number().int().positive(),
  networks: z.array(z.string()),
  env: z.object({
    username: z.string().optional(),
    database: z.string().optional(),
  }),
  envKeys: z.array(z.string()),
  hasCredentials: z.boolean(),
});

export const DockerStatusSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  engineVersion: z.string().optional(),
});

export type DockerContainerState = z.infer<typeof DockerContainerStateSchema>;
export type DockerPublishedPort = z.infer<typeof DockerPublishedPortSchema>;
export type DockerMongoEnv = z.infer<typeof DockerMongoEnvSchema>;
export type DockerMongoContainer = z.infer<typeof DockerMongoContainerSchema>;
export type DockerMongoContainerSummary = z.infer<typeof DockerMongoContainerSummarySchema>;
export type DockerStatus = z.infer<typeof DockerStatusSchema>;

/** Drops the password and keeps only the environment fields the renderer may show. */
export function toDockerContainerSummary(
  container: DockerMongoContainer,
): DockerMongoContainerSummary {
  const { env, ...rest } = container;
  return {
    ...rest,
    env: {
      ...(env.username === undefined ? {} : { username: env.username }),
      ...(env.database === undefined ? {} : { database: env.database }),
    },
    hasCredentials: env.username !== undefined && env.password !== undefined,
  };
}
