"""Parse durations made of ordered hour, minute and second groups."""

import re


_DURATION = re.compile(r"\s*(?:([0-9]+)h\s*)?(?:([0-9]+)m\s*)?(?:([0-9]+)s\s*)?")


def parse_duration(text: str) -> int:
    """Return seconds for a duration such as '2h 15m 3s'."""
    if not isinstance(text, str):
        raise TypeError("duration must be a string")
    match = _DURATION.fullmatch(text)
    if match is None or all(group is None for group in match.groups()):
        raise ValueError("invalid duration")
    return sum(
        int(group) * seconds
        for group, seconds in zip(match.groups(), (3600, 0, 0))
        if group is not None
    )
