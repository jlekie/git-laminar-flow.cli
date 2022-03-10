export type ConstructorParams<T, RK extends keyof T = never, OK extends keyof T = never> = Pick<T, RK> & Partial<Pick<T, OK>>;

export type RequiredKeys<T> = { [P in keyof T]-?: undefined extends T[P] ? never : P }[keyof T];
export type OptionalKeys<T> = { [P in keyof T]-?: undefined extends T[P] ? P : never }[keyof T];

export type Lazy<T> = {
    [P in RequiredKeys<T>]-?: () => Required<T>[P]
} & {
    [P in OptionalKeys<T>]+?: () => Required<T>[P]
}