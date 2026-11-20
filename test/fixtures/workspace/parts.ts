// Fixture for the integration test: shared parts import the DSL but have no default export, so they are not a diagram.
import {box} from 'svg-diagram';

export const step = (title: string) => box({title});
