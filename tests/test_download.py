"""Run from the repo root: ~/ComfyUI/venv/bin/python -m unittest discover -s tests -v"""
import importlib.util
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("qm_download", ROOT / "download.py")
download = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(download)


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self._tmp.name) / "output"
        (self.base / "videos").mkdir(parents=True)
        (self.base / "run_00001.png").write_bytes(b"png")
        (self.base / "videos" / "clip_00001.mp4").write_bytes(b"mp4")
        (pathlib.Path(self._tmp.name) / "secret.txt").write_text("nope")
        self.dirs = {"output": str(self.base)}.get

    def tearDown(self):
        self._tmp.cleanup()

    def resolve(self, filename, subfolder="", ftype="output"):
        return download.resolve(filename, subfolder, ftype, self.dirs)

    def test_file_in_output_root(self):
        self.assertEqual(self.resolve("run_00001.png"), (200, str(self.base / "run_00001.png")))

    def test_file_in_subfolder(self):
        self.assertEqual(self.resolve("clip_00001.mp4", "videos"), (200, str(self.base / "videos" / "clip_00001.mp4")))

    def test_missing_file(self):
        self.assertEqual(self.resolve("gone.png"), (404, None))

    def test_bad_filenames(self):
        for name in ("", "/etc/passwd", "../secret.txt", "a..b.png"):
            with self.subTest(name=name):
                self.assertEqual(self.resolve(name), (400, None))

    def test_unknown_type(self):
        self.assertEqual(self.resolve("run_00001.png", ftype="models"), (400, None))

    def test_subfolder_cannot_escape(self):
        self.assertEqual(self.resolve("secret.txt", ".."), (403, None))
        self.assertEqual(self.resolve("secret.txt", "videos/../.."), (403, None))

    def test_directory_is_not_a_file(self):
        self.assertEqual(self.resolve("videos"), (404, None))


class HeaderTests(unittest.TestCase):
    def test_attachment_keeps_real_type(self):
        h = download.headers("run_00001.png")
        self.assertEqual(h["Content-Type"], "image/png")
        self.assertEqual(h["Content-Disposition"], "attachment; filename=\"run_00001.png\"; filename*=UTF-8''run_00001.png")
        self.assertEqual(download.headers("clip.mp4")["Content-Type"], "video/mp4")

    def test_unknown_type_is_octet_stream(self):
        self.assertEqual(download.headers("latent.xyz123")["Content-Type"], "application/octet-stream")

    def test_quote_and_non_ascii_names(self):
        h = download.headers('a"b ü.png')["Content-Disposition"]
        self.assertEqual(h, "attachment; filename=\"a\\\"b ?.png\"; filename*=UTF-8''a%22b%20%C3%BC.png")
        h.encode("latin-1")  # header value must stay encodable


if __name__ == "__main__":
    unittest.main()
