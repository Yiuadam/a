-- ISOLATED PREVIEW DATA ONLY.
-- Apply only to `bandup-organization-ui-preview`; never include this file in
-- D1 migrations or any database that contains migrated learner records.
-- Every identity uses the reserved preview.bandup.invalid domain and fixed UUIDs.
PRAGMA foreign_keys = ON;

INSERT INTO app_users (id, email, role, created_at, updated_at) VALUES
  ('22222222-2222-4222-8222-222222222222', 'manager@preview.bandup.invalid', 'user', '2026-07-03T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000001', 'teacher@preview.bandup.invalid', 'user', '2026-07-06T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000002', 'student@preview.bandup.invalid', 'user', '2026-07-12T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000003', 'sofia@preview.bandup.invalid', 'user', '2026-07-18T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('70000000-0000-4000-8000-000000000001', 'noah@preview.bandup.invalid', 'user', '2026-08-11T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('90000000-0000-4000-8000-000000000001', 'admin@preview.bandup.invalid', 'admin', '2026-07-01T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('90000000-0000-4000-8000-000000000002', 'individual@preview.bandup.invalid', 'user', '2026-08-01T09:00:00.000Z', '2026-08-12T00:00:00.000Z')
  ,('90000000-0000-4000-8000-000000000003', 'candidate@preview.bandup.invalid', 'user', '2026-08-05T09:00:00.000Z', '2026-08-12T00:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET email = excluded.email, role = excluded.role,
  updated_at = excluded.updated_at, deleted_at = NULL;

INSERT INTO learner_profiles (user_id, display_name, updated_at) VALUES
  ('22222222-2222-4222-8222-222222222222', 'Adam Manager', '2026-08-12T00:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000001', 'Maya Chen', '2026-08-12T00:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000002', 'Leo Wong', '2026-08-12T00:00:00.000Z'),
  ('50000000-0000-4000-8000-000000000003', 'Sofia Lam', '2026-08-12T00:00:00.000Z'),
  ('70000000-0000-4000-8000-000000000001', 'Noah Lee', '2026-08-12T00:00:00.000Z'),
  ('90000000-0000-4000-8000-000000000001', 'BandUp administrator', '2026-08-12T00:00:00.000Z'),
  ('90000000-0000-4000-8000-000000000002', 'Independent learner', '2026-08-12T00:00:00.000Z')
  ,('90000000-0000-4000-8000-000000000003', 'Jamie Candidate', '2026-08-12T00:00:00.000Z')
ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name,
  updated_at = excluded.updated_at;

INSERT INTO usernames (username, user_id, created_at) VALUES
  ('adam.manager', '22222222-2222-4222-8222-222222222222', '2026-07-03T09:00:00.000Z'),
  ('maya.chen', '50000000-0000-4000-8000-000000000001', '2026-07-06T09:00:00.000Z'),
  ('leo.wong', '50000000-0000-4000-8000-000000000002', '2026-07-12T09:00:00.000Z'),
  ('sofia.lam', '50000000-0000-4000-8000-000000000003', '2026-07-18T09:00:00.000Z'),
  ('noah.lee', '70000000-0000-4000-8000-000000000001', '2026-08-11T09:00:00.000Z'),
  ('bandup.preview.admin', '90000000-0000-4000-8000-000000000001', '2026-07-01T09:00:00.000Z'),
  ('independent.learner', '90000000-0000-4000-8000-000000000002', '2026-08-01T09:00:00.000Z')
  ,('jamie.candidate', '90000000-0000-4000-8000-000000000003', '2026-08-05T09:00:00.000Z')
ON CONFLICT(username) DO UPDATE SET user_id = excluded.user_id;

INSERT INTO subscriptions (
  id, user_id, provider, status, tier, current_period_end,
  verified_at, created_at, updated_at
) VALUES
  ('b0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'stripe', 'active', 'plus', '2027-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-07-12T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('b0000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000003', 'stripe', 'active', 'standard', '2027-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-07-18T09:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  ('b0000000-0000-4000-8000-000000000003', '70000000-0000-4000-8000-000000000001', 'stripe', 'active', 'standard', '2027-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-11T09:00:00.000Z', '2026-08-12T00:00:00.000Z')
  ,('b0000000-0000-4000-8000-000000000004', '90000000-0000-4000-8000-000000000003', 'stripe', 'active', 'standard', '2027-08-12T00:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-05T09:00:00.000Z', '2026-08-12T00:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET status = excluded.status, tier = excluded.tier,
  current_period_end = excluded.current_period_end, verified_at = excluded.verified_at,
  updated_at = excluded.updated_at;

INSERT INTO organization_applications (
  id, applicant_user_id, organization_name, purpose, country, contact_email,
  estimated_students, applicant_role, status, submitted_at, reviewed_at,
  reviewed_by, review_note, created_at, updated_at
) VALUES
  ('c0000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Harbour English Academy', 'Provide a managed IELTS learning workspace for students and teachers.', 'Hong Kong', 'manager@preview.bandup.invalid', 30, 'Director', 'approved', '2026-07-02T09:00:00.000Z', '2026-07-03T08:00:00.000Z', '90000000-0000-4000-8000-000000000001', 'Approved for preview testing.', '2026-07-02T09:00:00.000Z', '2026-07-03T08:00:00.000Z'),
  ('c0000000-0000-4000-8000-000000000002', '90000000-0000-4000-8000-000000000002', 'North Point Learning Studio', 'Create a small managed IELTS workspace for independent tutors and learners.', 'Hong Kong', 'individual@preview.bandup.invalid', 12, 'Tutor', 'submitted', '2026-08-11T10:00:00.000Z', NULL, NULL, NULL, '2026-08-11T10:00:00.000Z', '2026-08-11T10:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET status = excluded.status, reviewed_at = excluded.reviewed_at,
  reviewed_by = excluded.reviewed_by, review_note = excluded.review_note,
  updated_at = excluded.updated_at;

INSERT INTO organizations (
  id, application_id, name, slug, status, created_by, created_at, updated_at, join_code
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'c0000000-0000-4000-8000-000000000001',
    'Harbour English Academy', 'harbour-english', 'active',
    '22222222-2222-4222-8222-222222222222',
    '2026-07-03T09:00:00.000Z', '2026-08-12T00:00:00.000Z', 'harbour-preview'
  ),
  (
    '11111111-1111-4111-8111-111111111112',
    NULL,
    'Bright Path College', 'bright-path-college', 'active',
    '90000000-0000-4000-8000-000000000001',
    '2026-07-16T09:00:00.000Z', '2026-08-12T00:00:00.000Z', 'bright-preview'
  )
ON CONFLICT(id) DO UPDATE SET name = excluded.name, slug = excluded.slug,
  status = excluded.status, updated_at = excluded.updated_at,
  join_code = excluded.join_code;

INSERT INTO organization_seat_pools (
  id, organization_id, provider, external_reference, seat_count,
  starts_at, ends_at, status, created_at, updated_at
) VALUES (
  'd0000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', 'manual', 'preview-pool', 30,
  '2026-07-03T09:00:00.000Z', NULL, 'active',
  '2026-07-03T09:00:00.000Z', '2026-08-12T00:00:00.000Z'
)
ON CONFLICT(id) DO UPDATE SET seat_count = excluded.seat_count,
  status = excluded.status, updated_at = excluded.updated_at;

INSERT INTO organization_memberships (
  id, organization_id, user_id, role, status, share_future_history,
  share_pre_join_history, joined_at, created_at, updated_at, status_changed_at
) VALUES
  ('33333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222', 'manager', 'active', 1, 1, '2026-07-03T09:00:00.000Z', '2026-07-03T09:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-07-03T09:00:00.000Z'),
  ('40000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '50000000-0000-4000-8000-000000000001', 'teacher', 'active', 1, 0, '2026-07-06T09:00:00.000Z', '2026-07-06T09:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-07-06T09:00:00.000Z'),
  ('40000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '50000000-0000-4000-8000-000000000002', 'student', 'active', 1, 1, '2026-07-12T09:00:00.000Z', '2026-07-12T09:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-07-12T09:00:00.000Z'),
  ('40000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', '50000000-0000-4000-8000-000000000003', 'student', 'active', 1, 1, '2026-07-18T09:00:00.000Z', '2026-07-18T09:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-07-18T09:00:00.000Z'),
  ('40000000-0000-4000-8000-000000000004', '11111111-1111-4111-8111-111111111111', '70000000-0000-4000-8000-000000000001', 'student', 'pending', 1, 0, NULL, '2026-08-11T13:30:00.000Z', '2026-08-11T13:30:00.000Z', '2026-08-11T13:30:00.000Z'),
  ('40000000-0000-4000-8000-000000000005', '11111111-1111-4111-8111-111111111112', '50000000-0000-4000-8000-000000000001', 'teacher', 'active', 1, 0, '2026-08-03T09:00:00.000Z', '2026-08-03T09:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-03T09:00:00.000Z'),
  ('40000000-0000-4000-8000-000000000006', '11111111-1111-4111-8111-111111111112', '50000000-0000-4000-8000-000000000002', 'student', 'active', 1, 0, '2026-08-02T09:00:00.000Z', '2026-08-02T09:00:00.000Z', '2026-08-12T00:00:00.000Z', '2026-08-02T09:00:00.000Z')
ON CONFLICT(organization_id, user_id) DO UPDATE SET role = excluded.role,
  status = excluded.status, share_future_history = excluded.share_future_history,
  share_pre_join_history = excluded.share_pre_join_history,
  joined_at = excluded.joined_at, updated_at = excluded.updated_at,
  status_changed_at = excluded.status_changed_at;

INSERT INTO organization_requests (
  id, organization_id, kind, status, requester_user_id, target_user_id,
  note, created_at, updated_at
) VALUES (
  '60000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111', 'join', 'pending',
  '70000000-0000-4000-8000-000000000001',
  '70000000-0000-4000-8000-000000000001',
  'Joining the evening IELTS class.',
  '2026-08-11T13:30:00.000Z', '2026-08-11T13:30:00.000Z'
)
ON CONFLICT(id) DO UPDATE SET status = excluded.status, decided_by = NULL,
  decided_at = NULL, updated_at = excluded.updated_at;

INSERT INTO teacher_student_assignments (
  id, organization_id, teacher_user_id, student_user_id,
  assigned_by, created_at, revoked_at, revoked_by
) VALUES
  ('80000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', '2026-07-13T09:00:00.000Z', NULL, NULL),
  ('80000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', '50000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', '2026-07-19T09:00:00.000Z', NULL, NULL)
ON CONFLICT(organization_id, teacher_user_id, student_user_id)
  WHERE revoked_at IS NULL DO NOTHING;

INSERT INTO practice_attempts (
  id, user_id, module, test_id, test_title, submitted_at,
  score, score_out_of, band, feedback_summary, result_inline,
  result_object_key, result_sha256, result_bytes, created_at, updated_at, source_key
) VALUES
  ('a0000000-0000-4000-8000-000000000010', '50000000-0000-4000-8000-000000000002', 'listening', 'listening-booking', 'Booking a badminton class', '2026-07-22T08:00:00.000Z', 27, 40, 6.5, 'Check singular and plural endings before moving on.', '{"module":"listening","testId":"listening-booking","testTitle":"Booking a badminton class","raw":27,"total":40,"band":6.5,"date":"2026-07-22T08:00:00.000Z"}', NULL, '143e7746784e2be65462da9f5784b99d0afd6de8349f13f19fb833f8f7686d45', 156, '2026-07-22T08:00:00.000Z', '2026-07-22T08:00:00.000Z', 'preview-listening-booking'),
  ('a0000000-0000-4000-8000-000000000011', '50000000-0000-4000-8000-000000000002', 'listening', 'listening-allotment', 'Renting an allotment plot', '2026-08-08T08:00:00.000Z', 30, 40, 7, 'Stronger detail recognition in the final section.', '{"module":"listening","testId":"listening-allotment","testTitle":"Renting an allotment plot","raw":30,"total":40,"band":7,"date":"2026-08-08T08:00:00.000Z"}', NULL, '144db47e6640f556d2396c27155cf13a4571a83b838adef93a7d18aaaaaffa89', 156, '2026-08-08T08:00:00.000Z', '2026-08-08T08:00:00.000Z', 'preview-listening-allotment'),
  ('a0000000-0000-4000-8000-000000000012', '50000000-0000-4000-8000-000000000002', 'reading', 'reading-lighthouse-old', 'The rise of the lighthouse', '2026-07-20T08:00:00.000Z', 24, 40, 6, 'Match headings by purpose rather than repeated words.', '{"module":"reading","testId":"reading-lighthouse-old","testTitle":"The rise of the lighthouse","raw":24,"total":40,"band":6,"date":"2026-07-20T08:00:00.000Z"}', NULL, '5dc3160193fd6bad3c4ebda3df4b99f9fe092dcc880f406a8c4cbc2342477662', 158, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', 'preview-reading-old'),
  ('a0000000-0000-4000-8000-000000000013', '50000000-0000-4000-8000-000000000002', 'reading', 'reading-lighthouse', 'The rise of the lighthouse', '2026-08-09T08:00:00.000Z', 27, 40, 6.5, 'Better control of True, False and Not Given questions.', '{"module":"reading","testId":"reading-lighthouse","testTitle":"The rise of the lighthouse","raw":27,"total":40,"band":6.5,"date":"2026-08-09T08:00:00.000Z","review":{"kind":"objective","questions":[{"id":"q1","type":"tfng","statement":"The lighthouse survived for many centuries.","answer":"TRUE","explanation":"The passage explicitly says it survived for many centuries."}],"answers":{"q1":"FALSE"},"advice":{"good":["Completed within the time limit"],"improve":["Underline the exact supporting sentence"]},"source":{"kind":"reading","passage":"The Pharos of Alexandria survived for many centuries before a series of earthquakes finally reduced it to rubble."}}}', NULL, '855caebcfdabb2845023dd0c58b6fea629831e6f66d602141900f3901f47e668', 663, '2026-08-09T08:00:00.000Z', '2026-08-09T08:00:00.000Z', 'preview-reading-current'),
  ('a0000000-0000-4000-8000-000000000014', '50000000-0000-4000-8000-000000000002', 'writing', 'writing-recycling', 'Household recycling rates', '2026-07-25T08:00:00.000Z', NULL, NULL, 5.5, 'Overview present; comparisons need greater precision.', '{"module":"writing","testId":"writing-recycling","testTitle":"Household recycling rates","band":5.5,"date":"2026-07-25T08:00:00.000Z"}', NULL, '2f965f6261c4cb373d4d46aa0539b89699c3d95c63977e3d22e93dce98ff04f0', 134, '2026-07-25T08:00:00.000Z', '2026-07-25T08:00:00.000Z', 'preview-writing-old'),
  ('a0000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'writing', 'writing-remote', 'Remote working — opinion essay', '2026-08-10T11:00:00.000Z', NULL, NULL, 6, 'A clear position with relevant support; paragraph development needs more depth.', '{"module":"writing","testId":"writing-remote","testTitle":"Remote working — opinion essay","band":6,"date":"2026-08-10T11:00:00.000Z","review":{"kind":"writing","attempts":[{"task":{"id":"writing-remote","task":2,"variant":"academic","title":"Remote working","prompt":"To what extent do you agree that remote working benefits both employers and employees?","minWords":250,"timeMinutes":40},"response":"Remote working can benefit both sides because employees save commuting time and employers can recruit from a wider area.","grade":{"overallBand":6,"criteria":[{"name":"Task response","band":6,"comment":"The position is clear but supporting ideas need fuller development."},{"name":"Coherence and cohesion","band":6,"comment":"The argument is logically ordered."}],"strengths":["Clear position","Relevant main ideas"],"improvements":["Add a specific example","Develop the counterargument"],"rewrittenExcerpt":"Remote work can benefit both parties: employees regain commuting time, while employers can recruit beyond their immediate region."}}]}}', NULL, 'd718808d990d6a3f4156b650a127503afc75813ff83c6bf943f989ef6a77a6d4', 1048, '2026-08-10T11:00:00.000Z', '2026-08-10T11:00:00.000Z', 'preview-writing-current'),
  ('a0000000-0000-4000-8000-000000000015', '50000000-0000-4000-8000-000000000002', 'speaking', 'speaking-old', 'IELTS speaking interview', '2026-07-28T08:00:00.000Z', NULL, NULL, 6, 'Clear answers; extend Part 2 with connected detail.', '{"module":"speaking","testId":"speaking-old","testTitle":"IELTS speaking interview","band":6,"date":"2026-07-28T08:00:00.000Z"}', NULL, '6de1083817e6f0f8358ae81a6c531bda158593f399ae08b7729f77253b5bd44f', 127, '2026-07-28T08:00:00.000Z', '2026-07-28T08:00:00.000Z', 'preview-speaking-old'),
  ('a0000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000002', 'speaking', 'speaking-current', 'IELTS speaking interview', '2026-08-12T08:20:00.000Z', NULL, NULL, 6.5, 'Clear ideas; develop answers with more precise examples.', '{"module":"speaking","testId":"speaking-current","testTitle":"IELTS speaking interview","band":6.5,"date":"2026-08-12T08:20:00.000Z","review":{"kind":"speaking","transcript":[{"role":"examiner","part":1,"text":"What do you enjoy about where you live?"},{"role":"candidate","part":1,"text":"I enjoy the harbour because it is peaceful in the evening and easy to reach from home."}],"grade":{"overallBand":6.5,"criteria":[{"name":"Fluency and coherence","band":6.5,"comment":"Ideas are clear, with occasional hesitation."},{"name":"Lexical resource","band":6.5,"comment":"Appropriate vocabulary with room for greater precision."}],"strengths":["Direct response","Natural pace"],"improvements":["Extend answers with one specific example","Use a wider range of linking phrases"],"betterAnswerExample":"I especially enjoy the harbour in the evening, when it becomes quieter and the lights reflect across the water.","pronunciationNote":"Word stress is generally clear; keep final consonants audible."}}}', NULL, 'dda1e0dec581248143341c3f7762401fac9b1f1a5348f1508ae7a04d90a97b04', 997, '2026-08-12T08:20:00.000Z', '2026-08-12T08:20:00.000Z', 'preview-speaking-current')
ON CONFLICT(id) DO UPDATE SET test_title = excluded.test_title,
  score = excluded.score, score_out_of = excluded.score_out_of,
  band = excluded.band, feedback_summary = excluded.feedback_summary,
  result_inline = excluded.result_inline, result_object_key = NULL,
  result_sha256 = excluded.result_sha256, result_bytes = excluded.result_bytes,
  updated_at = excluded.updated_at;

UPDATE practice_attempts
   SET result_has_review = CASE
     WHEN json_type(result_inline, '$.review') = 'object' THEN 1 ELSE 0
   END
 WHERE user_id IN (
   '50000000-0000-4000-8000-000000000002',
   '50000000-0000-4000-8000-000000000003'
 );

-- Learning-work fixtures make the student and teacher notification views
-- reviewable without accepting writes in the shared public preview.
INSERT INTO organization_practice_assignments (
  id, organization_id, assigned_by_user_id, student_user_id,
  module, test_id, test_title, note, due_at, assigned_at, updated_at
) VALUES
  (
    '81000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    'reading', 'reading-1', 'Reading · The Rise of the Lighthouse',
    'Focus on headings: match the writer''s main idea, not repeated words.',
    '2026-08-17T00:00:00.000Z',
    '2026-08-12T09:00:00.000Z', '2026-08-12T09:00:00.000Z'
  ),
  (
    '81000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    'speaking', 'next-speaking', 'Speaking · next interview',
    'Give one specific example in each longer answer.', NULL,
    '2026-08-09T09:00:00.000Z', '2026-08-12T09:00:00.000Z'
  )
ON CONFLICT(id) DO UPDATE SET
  assigned_by_user_id = excluded.assigned_by_user_id,
  student_user_id = excluded.student_user_id,
  module = excluded.module,
  test_id = excluded.test_id,
  test_title = excluded.test_title,
  note = excluded.note,
  due_at = excluded.due_at,
  assigned_at = excluded.assigned_at,
  updated_at = excluded.updated_at;

INSERT INTO organization_teacher_feedback (
  id, organization_id, attempt_id, student_user_id, teacher_user_id,
  message, created_at, updated_at
) VALUES (
  '82000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'a0000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  'Your ideas are clear. Next time, add one example before you move to the next point.',
  '2026-08-12T09:15:00.000Z', '2026-08-12T09:15:00.000Z'
)
ON CONFLICT(organization_id, attempt_id, teacher_user_id) DO UPDATE SET
  message = excluded.message,
  updated_at = excluded.updated_at;

-- Notifications store typed references only. The inbox derives its wording
-- and links from the authoritative rows above, so no essay, transcript,
-- feedback body or email address is duplicated here.
INSERT INTO user_notifications (
  id, recipient_user_id, actor_user_id, organization_id, kind,
  entity_id, related_entity_id, dedupe_key, read_at, created_at
) VALUES
  (
    '83000000-0000-4000-8000-000000000001',
    '22222222-2222-4222-8222-222222222222',
    '70000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'organization_request', '60000000-0000-4000-8000-000000000001',
    'join', 'preview:manager:join-request', NULL,
    '2026-08-11T13:30:00.000Z'
  ),
  (
    '83000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'practice_assigned', '81000000-0000-4000-8000-000000000001',
    NULL, 'preview:student:practice-assigned', NULL,
    '2026-08-12T09:00:00.000Z'
  ),
  (
    '83000000-0000-4000-8000-000000000003',
    '50000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'teacher_feedback', 'a0000000-0000-4000-8000-000000000001',
    NULL, 'preview:student:teacher-feedback', NULL,
    '2026-08-12T09:15:00.000Z'
  ),
  (
    '83000000-0000-4000-8000-000000000004',
    '50000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002',
    '11111111-1111-4111-8111-111111111111',
    'assignment_completed', 'a0000000-0000-4000-8000-000000000001',
    '81000000-0000-4000-8000-000000000002',
    'preview:teacher:assignment-completed', NULL,
    '2026-08-12T09:16:00.000Z'
  )
ON CONFLICT(dedupe_key) DO UPDATE SET
  recipient_user_id = excluded.recipient_user_id,
  actor_user_id = excluded.actor_user_id,
  organization_id = excluded.organization_id,
  kind = excluded.kind,
  entity_id = excluded.entity_id,
  related_entity_id = excluded.related_entity_id,
  read_at = excluded.read_at,
  created_at = excluded.created_at;
