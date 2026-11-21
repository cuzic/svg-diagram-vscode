import {box, connect, diagram, row} from 'svg-diagram';

export default function define() {
  return diagram({theme: 'blue', title: 'Preview links', width: 220}).add(
    row([
      box({id: 'a', title: 'Start'}),
      box({id: 'b', title: 'End'}),
    ], {gap: 48, arrows: 'none'}),
    connect('a:right', 'b:left', {route: 'straight'}),
  );
}
