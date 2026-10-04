"""Apply reviewed text edits without moving the original command/save positions."""
import copy
import json
import sys
from pathlib import Path


def revise_story(story, edits=None):
    edits = edits or json.loads(Path(__file__).with_name('story_edits.json').read_text())
    if story['sourceHash'] != edits['sourceHash']:
        raise ValueError('Text edits require the reviewed original Story.data version')
    maps = {m['id']: m for m in story['maps']}
    for change in edits['texts']:
        event = maps[change['map']]['events'][change['event']]
        if event['code'] != 100:
            raise ValueError(f"Text position changed: {change['map']}:{change['event']}")
        actual = {'speaker': event['p'][0], 'text': event['p'][2]}
        # Accept earlier reviewed wording as well as the original and latest text.
        # The original remains in `before` for importing the binary and old saves.
        if actual not in [change['before'], change['after'], *change.get('previous', [])]:
            raise ValueError(f"Text no longer matches review: {change['map']}:{change['event']}")
        event['legacy'] = copy.deepcopy(change['before'])
        event['p'][0] = change['after']['speaker']
        event['p'][2] = change['after']['text']
        if change.get('interlude'):
            event['interlude'] = True
        if change.get('skipText'):
            event['skipText'] = True
    for change in edits['choices']:
        event = maps[change['map']]['events'][change['event']]
        accepted = [change['before'], change['after'], *change.get('previous', [])]
        if event['code'] != 101 or event['p'] not in accepted:
            raise ValueError(f"Choice no longer matches review: {change['map']}:{change['event']}")
        if len(event['choices']) != len(change['after']):
            raise ValueError('Reviewed choices must retain the original branch count')
        event['p'] = copy.deepcopy(change['after'])
        event['prompt'] = change['prompt']
        for index, choice in enumerate(event['choices']):
            choice['text'] = change['after'][index]
            choice['hypothetical'] = index != change['correct'] and change.get('hypothetical', True)
    for change in edits['endings']:
        event = maps[change['map']]['events'][change['event']]
        if event['code'] != 208:
            raise ValueError(f"Ending position changed: {change['map']}:{change['event']}")
        event['ending'] = copy.deepcopy(change['ending'])
    story['revision'] = edits['revision']
    return story


if __name__ == '__main__':
    target = Path(sys.argv[1])
    story = revise_story(json.loads(target.read_text()))
    target.write_text(json.dumps(story, ensure_ascii=False, separators=(',', ':')))
    print(json.dumps({'revision': story['revision'], 'commands': sum(len(m['events']) for m in story['maps'])}))
