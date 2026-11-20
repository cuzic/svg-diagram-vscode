// Fixture for the integration test: a source that throws while it is built, so `check` reports build-error.
import {diagram} from 'svg-diagram';

export default function define() {
  throw new Error('fixture: わざと壊した図');
  return diagram({theme: 'blue', title: '壊れた図'});
}
