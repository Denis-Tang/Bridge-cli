-- 003_target_merge_commit: M2 fix — track final target branch merge commit
-- 对应契约违例修复：integration batch 需记录目标分支合并 commit

ALTER TABLE integration_batches ADD COLUMN target_merge_commit TEXT;
