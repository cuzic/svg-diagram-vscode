// Fixture for the e2e test: takes 3 seconds to build, so the preview can be looked at while it is still drawing.
import {box, diagram} from 'svg-diagram';

export default function define() {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000);
  return diagram({theme: 'blue', title: '遅い図'}).add(box({id: 's', title: 'S'}));
}
