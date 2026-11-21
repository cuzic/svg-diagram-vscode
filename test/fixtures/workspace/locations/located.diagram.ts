import {box, diagram} from 'svg-diagram';
import {step} from '../parts.ts';

export default function define() {
  return diagram({theme: 'blue'}).add(
    box({title: 'A'}),
    step('B'),
  );
}
