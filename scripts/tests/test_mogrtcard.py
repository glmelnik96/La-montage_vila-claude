import base64
import gzip
import io
import json
import struct
import sys
import tempfile
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree as ET

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import mogrtcard


KEY = '-91445760000000000,0.25,0.52,0,0,0,0,0,0,5,4,0,0,0,0'
TEMPLATE_ID = '5883b98b-6f02-4364-9ffa-11111a218500'
LOCALES = ['project.prgraphic', 'project_ru_RU.prgraphic']


def project(position_id='21', label='Position', sizes=None):
    style = {'mText': 'Donor', 'mFontName': {'mParamValues': [[0, 'DonorFont']]},
             'mFontSize': {'mParamValues': sizes or [[0, 48]]}}
    body = json.dumps({'mTextParam': {'mStyleSheet': style, 'mLeading': 12}}).encode('utf-16-le')
    source = base64.b64encode(struct.pack('<Q', len(body)) + body).decode('ascii')
    return f'''<Project>
<VideoFilterComponent><Component><Params><Param Index="0" ObjectRef="11"/>
<Param Index="2" ObjectRef="{position_id}"/></Params></Component>
<MatchName>AE.ADBE Text</MatchName></VideoFilterComponent>
<ArbVideoComponentParam ObjectID="11"><IsTimeVarying>false</IsTimeVarying>
<StartKeyframeValue Encoding="base64">{source}</StartKeyframeValue><ParameterID>1</ParameterID></ArbVideoComponentParam>
<PointComponentParam ObjectID="{position_id}"><Name>{label}</Name><IsTimeVarying>false</IsTimeVarying>
<StartKeyframe>{KEY}</StartKeyframe><ParameterID>3</ParameterID></PointComponentParam>
<VideoFilterComponent><Component><Params><Param Index="2" ObjectRef="80"/></Params></Component>
<MatchName>AE.ADBE Motion</MatchName></VideoFilterComponent>
<PointComponentParam ObjectID="80"><Name>Position</Name><StartKeyframe>{KEY}</StartKeyframe>
<Keyframes>untouched</Keyframes></PointComponentParam><!-- preserve -->
</Project>'''


def template(path, second_xml):
    with zipfile.ZipFile(path, 'w') as mogrt:
        mogrt.writestr('definition.json', json.dumps({'capsuleID': TEMPLATE_ID}))
        for name, xml in zip(LOCALES, (project(), second_xml)):
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, 'w') as localized:
                localized.writestr('test.prproj', gzip.compress(xml.encode('utf-8')))
                localized.writestr('asset.dat', b'asset')
            mogrt.writestr(name, buf.getvalue())


class MogrtCardTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.folder = Path(self.directory.name)
        self.donor = self.folder / 'donor.mogrt'
        self.ru = project('32', 'Положение')
        template(self.donor, self.ru)
        change_path = patch.object(mogrtcard, 'SRC', self.donor)
        change_path.start()
        self.addCleanup(change_path.stop)

    def test_donor_style_preserved_and_character_ranges_rejected(self):
        with patch.object(mogrtcard, 'PRESERVE_STYLE', True):
            card = {'id': 'preserved', 'text': 'New copy', 'textPosition': [0, 1]}
            path = mogrtcard.make(card, self.folder)
            with zipfile.ZipFile(path) as mogrt, zipfile.ZipFile(io.BytesIO(mogrt.read(LOCALES[1]))) as localized:
                root = ET.fromstring(gzip.decompress(localized.read('test.prproj')))
            raw = base64.b64decode(root.findtext('./ArbVideoComponentParam/StartKeyframeValue'))
            tp = json.loads(raw[8:].decode('utf-16-le'))['mTextParam']
            self.assertEqual(tp['mLeading'], 12)
            self.assertEqual(tp['mStyleSheet']['mFontName']['mParamValues'], [[0, 'DonorFont']])
            self.assertEqual(tp['mStyleSheet']['mFontSize']['mParamValues'], [[0, 48]])
            template(self.donor, project(sizes=[[0, 48], [3, 24]]))
            with self.assertRaisesRegex(ValueError, 'uniform donor style'):
                mogrtcard.make(card, self.folder)

    def test_every_locale_receives_exact_lines_and_only_target_position(self):
        copy = 'An approved single title longer than the wrapping threshold'
        for name, text in [('one', copy), ('two', 'первая\r\nвторая')]:
            path = mogrtcard.make({'id': name, 'text': text, 'textPosition': [0.7, 0.4097]}, self.folder)
            with zipfile.ZipFile(path) as mogrt:
                new_id = json.loads(mogrt.read('definition.json'))['capsuleID']
                self.assertEqual(uuid.UUID(new_id).version, 4)
                self.assertNotEqual(new_id, TEMPLATE_ID)
                for locale in LOCALES:
                    with zipfile.ZipFile(io.BytesIO(mogrt.read(locale))) as localized:
                        self.assertEqual(localized.read('asset.dat'), b'asset')
                        xml = gzip.decompress(localized.read('test.prproj')).decode()
                    root = ET.fromstring(xml)
                    point = root.find("./PointComponentParam[ParameterID='3']/StartKeyframe")
                    expected_key = KEY.replace('0.25,0.52', '0.7,0.4097')
                    self.assertEqual(point.text, expected_key)
                    self.assertEqual(root.findtext("./PointComponentParam[@ObjectID='80']/StartKeyframe"), KEY)
                    self.assertIn('<Keyframes>untouched</Keyframes></PointComponentParam><!-- preserve -->', xml)
                    value = root.findtext('./ArbVideoComponentParam/StartKeyframeValue')
                    raw = base64.b64decode(value)
                    self.assertEqual(struct.unpack('<Q', raw[:8])[0], len(raw[8:]))
                    style = json.loads(raw[8:].decode('utf-16-le'))['mTextParam']['mStyleSheet']
                    self.assertEqual(style['mText'], text.replace('\r\n', '\r'))

    def test_legacy_card_still_wraps_and_preserves_donor_position(self):
        with patch.object(mogrtcard, 'WIDTH', 5):
            result = mogrtcard.make({'id': 'old', 'text': 'alpha beta'}, self.folder)
        with zipfile.ZipFile(result) as mogrt, zipfile.ZipFile(io.BytesIO(mogrt.read(LOCALES[0]))) as localized:
            root = ET.fromstring(gzip.decompress(localized.read('test.prproj')))
        self.assertEqual(root.findtext("./PointComponentParam[ParameterID='3']/StartKeyframe"), KEY)
        raw = base64.b64decode(root.findtext('./ArbVideoComponentParam/StartKeyframeValue'))
        self.assertEqual(json.loads(raw[8:].decode('utf-16-le'))['mTextParam']['mStyleSheet']['mText'], 'alpha\rbeta')

    def test_invalid_position_rejected_before_writing(self):
        for bad in [None, [True, 0.5], [0.5], [0.5, float('nan')], [1.1, 0.1]]:
            with self.subTest(value=bad), self.assertRaisesRegex(ValueError, 'textPosition'):
                mogrtcard.make({'id': 'bad', 'text': 'title', 'textPosition': bad}, self.folder)
        self.assertFalse((self.folder / 'bad.mogrt').exists())

    def test_unsupported_localized_project_leaves_existing_card_intact(self):
        good = mogrtcard.make({'id': 'card', 'text': 'approved'}, self.folder)
        original = Path(good).read_bytes()
        variants = [
            self.ru.replace('ObjectRef="32"', 'ObjectRef="80"'),
            self.ru.replace('<Name>Положение</Name><IsTimeVarying>false', '<Name>Положение</Name><IsTimeVarying>true'),
            self.ru.replace('</StartKeyframe><ParameterID>3', '</StartKeyframe><Keyframes>key</Keyframes><ParameterID>3'),
            self.ru.replace('</Project>', '<VideoFilterComponent><MatchName>AE.ADBE Text</MatchName></VideoFilterComponent></Project>'),
            self.ru.replace(KEY, '0,0.5,0.5'),
        ]
        for xml in variants:
            template(self.donor, xml)
            with self.subTest(xml=xml), self.assertRaisesRegex(ValueError, 'project_ru_RU.prgraphic'):
                mogrtcard.make({'id': 'card', 'text': 'title', 'textPosition': [0.4, 0.7]}, self.folder)
            self.assertEqual(Path(good).read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
