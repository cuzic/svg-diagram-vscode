// Fixture for the integration test: builds, but has no title, so `check` reports a finding as JSON.
import {box, diagram} from 'svg-diagram';

export default function define() {
  return diagram({theme: 'blue'}).add(box({id: 'a', title: 'A'}));
}
