-- 007_execution_config_snapshot.sql
-- Add execution_config_snapshot column to runs table for resume-time config restoration.

ALTER TABLE runs ADD COLUMN execution_config_snapshot TEXT;
