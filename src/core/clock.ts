// Every rule that depends on time reads it from here, so tests can move time instead of waiting.
export type Clock = () => Date
export const systemClock: Clock = () => new Date()
