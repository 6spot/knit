import unittest

from duration import parse_duration


class ParseDurationTests(unittest.TestCase):
    def test_valid_durations(self):
        cases = {
            "0s": 0,
            "0h0m0s": 0,
            "1h": 3600,
            "2m": 120,
            "3s": 3,
            "1h2m": 3720,
            "1h3s": 3603,
            "2m3s": 123,
            "1h2m3s": 3723,
            " \t1h\n2m\t3s\r\n": 3723,
            "90m": 5400,
            "120s": 120,
            "001h 02m 03s": 3723,
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(parse_duration(text), expected)

    def test_invalid_durations(self):
        cases = (
            "", " \t\n", "1", "1h 2", "h", "1 h", "-1h", "1h-2m",
            "+1s", "1.5h", "1h1h", "1m1m", "1s1s", "1m1h", "1s1m",
            "1s1h", "1h1s1m", "junk", "x1s", "1sx", "1H", "1h,2m",
        )
        for text in cases:
            with self.subTest(text=text):
                with self.assertRaises(ValueError):
                    parse_duration(text)

    def test_non_strings(self):
        for value in (None, 1, 1.5, True, b"1h", [], {}):
            with self.subTest(value=value):
                with self.assertRaises(TypeError):
                    parse_duration(value)


if __name__ == "__main__":
    unittest.main()
