/*
 * Copyright (c) 2025, WSO2 LLC. (http://www.wso2.org) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import React, {
    useState, useEffect, useCallback, useRef,
} from 'react';
import { FormattedMessage, useIntl } from 'react-intl';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Box,
    Chip,
    FormControlLabel,
    Grid,
    MenuItem,
    Slider,
    Switch,
    TextField,
    Tooltip,
    Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import TuneIcon from '@mui/icons-material/Tune';
import SecurityIcon from '@mui/icons-material/Security';
import SpeedIcon from '@mui/icons-material/Speed';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import PropTypes from 'prop-types';

/**
 * Simple YAML parser for deduplication config.
 * Handles the well-known flat structure without requiring js-yaml dependency.
 */
function parseSimpleYaml(yamlStr) {
    const result = { deduplication: {}, rules: {} };
    if (!yamlStr) return result;

    let currentSection = null;
    let currentRule = null;
    let multiLineKey = null;
    let multiLineValue = '';

    const lines = yamlStr.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('#') || trimmed === '') {
            // skip comments and blank lines
        } else {
            const indent = line.search(/\S/);

            if (indent === 0 && trimmed.endsWith(':')) {
                // Top-level section header
                if (multiLineKey && currentRule) {
                    result.rules[currentRule][multiLineKey] = multiLineValue;
                    multiLineKey = null;
                    multiLineValue = '';
                }
                currentSection = trimmed.slice(0, -1);
                currentRule = null;
            } else if (currentSection === 'deduplication' && indent >= 2) {
                const match = trimmed.match(/^([\w_]+):\s*(.*)$/);
                if (match) {
                    const key = match[1];
                    let value = match[2].trim();
                    if (value === 'true') value = true;
                    else if (value === 'false') value = false;
                    else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
                    else if (/^\d+$/.test(value)) value = parseInt(value, 10);
                    result.deduplication[key] = value;
                }
            } else if (currentSection === 'rules') {
                // Flush multi-line if we're back at rule-key indent
                if (multiLineKey && indent <= 4 && trimmed.match(/^[\w_-]+:/)) {
                    if (currentRule) {
                        result.rules[currentRule][multiLineKey] = multiLineValue;
                    }
                    multiLineKey = null;
                    multiLineValue = '';
                }

                if (indent === 2 && trimmed.endsWith(':')) {
                    currentRule = trimmed.slice(0, -1);
                    result.rules[currentRule] = {};
                } else if (indent >= 4 && currentRule && !multiLineKey) {
                    const match = trimmed.match(/^([\w_-]+):\s*(.*)$/);
                    if (match) {
                        const key = match[1];
                        const rawValue = match[2].trim();
                        if (rawValue === '>-' || rawValue === '>' || rawValue === '|') {
                            multiLineKey = key;
                            multiLineValue = '';
                        } else {
                            result.rules[currentRule][key] = rawValue;
                        }
                    }
                } else if (multiLineKey && indent >= 6) {
                    if (multiLineValue) multiLineValue += ' ';
                    multiLineValue += trimmed;
                }
            }
        }
    }

    // Flush any remaining multi-line value
    if (multiLineKey && currentRule) {
        result.rules[currentRule][multiLineKey] = multiLineValue;
    }

    return result;
}

/**
 * Serialize dedup config to YAML string without js-yaml dependency.
 */
function toSimpleYaml(cfg) {
    const d = cfg.deduplication;
    const ruleKey = Object.keys(cfg.rules)[0] || 'api-deduplication-check';
    const rule = cfg.rules[ruleKey] || {};

    return [
        'deduplication:',
        `  enabled: ${d.enabled}`,
        `  similarity_threshold: ${d.similarity_threshold}`,
        `  high_confidence_threshold: ${d.high_confidence_threshold}`,
        `  mode: ${d.mode}`,
        `  num_hash_functions: ${d.num_hash_functions}`,
        `  num_bands: ${d.num_bands}`,
        `  shingle_size: ${d.shingle_size}`,
        'rules:',
        `  ${ruleKey}:`,
        `    description: ${rule.description || ''}`,
        `    severity: ${rule.severity || 'error'}`,
        '    message: >-',
        `      ${rule.message || ''}`,
        '',
    ].join('\n');
}

/**
 * GenericRulesetForm - Structured form for GENERIC (deduplication) rulesets.
 * Replaces the raw Monaco YAML editor with a user-friendly accordion form
 * containing sliders, toggles, and dropdowns for all dedup configuration.
 */
function GenericRulesetForm({ rulesetContent, onContentChange }) {
    const intl = useIntl();

    const defaultConfig = {
        deduplication: {
            enabled: true,
            similarity_threshold: 0.50,
            high_confidence_threshold: 0.99,
            mode: 'audit',
            num_hash_functions: 256,
            num_bands: 32,
            shingle_size: 5,
        },
        rules: {
            'api-deduplication-check': {
                description: 'Detects structurally similar APIs using MinHash/LSH algorithm',
                severity: 'error',
                message: 'This API has high structural similarity with existing APIs in the catalog. '
                    + 'Review for potential duplication or consolidation opportunities.',
            },
        },
    };

    const [config, setConfig] = useState(defaultConfig);
    const [expanded, setExpanded] = useState('detection');

    // Ref to track YAML we last serialized, so we can skip re-parsing our own output
    const lastSyncedYaml = useRef('');

    // Parse incoming YAML content whenever rulesetContent changes from external source
    useEffect(() => {
        if (rulesetContent && rulesetContent !== lastSyncedYaml.current) {
            try {
                const parsed = parseSimpleYaml(rulesetContent);
                if (parsed && parsed.deduplication
                    && Object.keys(parsed.deduplication).length > 0) {
                    setConfig((prev) => ({
                        ...prev,
                        deduplication: { ...prev.deduplication, ...parsed.deduplication },
                        rules: (parsed.rules
                            && Object.keys(parsed.rules).length > 0)
                            ? parsed.rules : prev.rules,
                    }));
                }
                lastSyncedYaml.current = rulesetContent;
            } catch (e) {
                // If YAML parsing fails, keep defaults
                console.warn('Failed to parse ruleset YAML:', e.message);
            }
        }
    }, [rulesetContent]);

    // Serialize config to YAML and notify parent
    const syncToYaml = useCallback((newConfig) => {
        try {
            const yaml = toSimpleYaml(newConfig);
            lastSyncedYaml.current = yaml;
            onContentChange(yaml);
        } catch (e) {
            console.error('Error serializing config to YAML:', e);
        }
    }, [onContentChange]);

    const updateDedup = useCallback((field, value) => {
        setConfig((prev) => {
            const updated = {
                ...prev,
                deduplication: { ...prev.deduplication, [field]: value },
            };
            syncToYaml(updated);
            return updated;
        });
    }, [syncToYaml]);

    const updateRule = useCallback((field, value) => {
        setConfig((prev) => {
            const ruleKey = Object.keys(prev.rules)[0] || 'api-deduplication-check';
            const updated = {
                ...prev,
                rules: {
                    ...prev.rules,
                    [ruleKey]: { ...prev.rules[ruleKey], [field]: value },
                },
            };
            syncToYaml(updated);
            return updated;
        });
    }, [syncToYaml]);

    const handleAccordionChange = (panel) => (event, isExpanded) => {
        setExpanded(isExpanded ? panel : false);
    };

    const { deduplication: dedup } = config;
    const ruleKey = Object.keys(config.rules)[0] || 'api-deduplication-check';
    const rule = config.rules[ruleKey] || {};

    // Compute the LSH probability threshold: 1-(1-t^r)^b where r=rows, b=bands
    const computeLSHProbability = () => {
        const t = dedup.similarity_threshold;
        const b = dedup.num_bands;
        const r = Math.floor(dedup.num_hash_functions / b);
        const prob = 1 - ((1 - (t ** r)) ** b);
        return (prob * 100).toFixed(1);
    };

    return (
        <Box sx={{ width: '100%' }}>
            {/* Header with enable toggle */}
            <Box sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                mb: 2,
                p: 2,
                bgcolor: 'grey.50',
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
            }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <SecurityIcon color={dedup.enabled ? 'primary' : 'disabled'} />
                    <Typography variant='subtitle1' fontWeight='bold'>
                        <FormattedMessage
                            id='Governance.Rulesets.GenericForm.dedup.title'
                            defaultMessage='API Deduplication Engine'
                        />
                    </Typography>
                    <Chip
                        label={dedup.enabled ? intl.formatMessage({
                            id: 'Governance.Rulesets.GenericForm.status.active',
                            defaultMessage: 'Active',
                        }) : intl.formatMessage({
                            id: 'Governance.Rulesets.GenericForm.status.disabled',
                            defaultMessage: 'Disabled',
                        })}
                        color={dedup.enabled ? 'success' : 'default'}
                        size='small'
                    />
                </Box>
                <FormControlLabel
                    control={(
                        <Switch
                            checked={dedup.enabled}
                            onChange={(e) => updateDedup('enabled', e.target.checked)}
                            color='primary'
                        />
                    )}
                    label={intl.formatMessage({
                        id: 'Governance.Rulesets.GenericForm.enable.label',
                        defaultMessage: 'Enable',
                    })}
                />
            </Box>

            {/* Detection Settings */}
            <Accordion
                expanded={expanded === 'detection'}
                onChange={handleAccordionChange('detection')}
                variant='outlined'
                sx={{ mb: 1 }}
            >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <TuneIcon fontSize='small' color='primary' />
                        <Typography variant='subtitle2'>
                            <FormattedMessage
                                id='Governance.Rulesets.GenericForm.detection.title'
                                defaultMessage='Detection Settings'
                            />
                        </Typography>
                    </Box>
                </AccordionSummary>
                <AccordionDetails>
                    <Grid container spacing={3}>
                        {/* Similarity Threshold */}
                        <Grid item xs={12}>
                            <Box sx={{
                                display: 'flex', alignItems: 'center', gap: 0.5, mb: 1,
                            }}
                            >
                                <Typography variant='body2' fontWeight='medium'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.similarity.label'
                                        defaultMessage='Similarity Threshold'
                                    />
                                </Typography>
                                <Tooltip title={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.similarity.tooltip',
                                    defaultMessage: 'APIs with Jaccard similarity above this value are flagged'
                                        + ' as potential duplicates. Lower = more sensitive, Higher = stricter.',
                                })}
                                >
                                    <InfoOutlinedIcon fontSize='small' color='action' />
                                </Tooltip>
                                <Chip
                                    label={`${(dedup.similarity_threshold * 100).toFixed(0)}%`}
                                    size='small'
                                    color='primary'
                                    sx={{ ml: 'auto' }}
                                />
                            </Box>
                            <Slider
                                value={dedup.similarity_threshold}
                                onChange={(e, val) => updateDedup('similarity_threshold', val)}
                                min={0.30}
                                max={1.00}
                                step={0.01}
                                marks={[
                                    { value: 0.30, label: '30%' },
                                    { value: 0.50, label: '50%' },
                                    { value: 0.80, label: '80%' },
                                    { value: 1.00, label: '100%' },
                                ]}
                                valueLabelDisplay='auto'
                                valueLabelFormat={(v) => `${(v * 100).toFixed(0)}%`}
                            />
                        </Grid>

                        {/* High Confidence Threshold */}
                        <Grid item xs={12}>
                            <Box sx={{
                                display: 'flex', alignItems: 'center', gap: 0.5, mb: 1,
                            }}
                            >
                                <Typography variant='body2' fontWeight='medium'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.highconf.label'
                                        defaultMessage='High Confidence Threshold'
                                    />
                                </Typography>
                                <Tooltip title={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.highconf.tooltip',
                                    defaultMessage: 'APIs exceeding this higher threshold are flagged as'
                                        + ' near-certain duplicates with CRITICAL severity.',
                                })}
                                >
                                    <InfoOutlinedIcon fontSize='small' color='action' />
                                </Tooltip>
                                <Chip
                                    label={`${(dedup.high_confidence_threshold * 100).toFixed(0)}%`}
                                    size='small'
                                    color='error'
                                    sx={{ ml: 'auto' }}
                                />
                            </Box>
                            <Slider
                                value={dedup.high_confidence_threshold}
                                onChange={(e, val) => updateDedup('high_confidence_threshold', val)}
                                min={0.80}
                                max={1.00}
                                step={0.01}
                                marks={[
                                    { value: 0.80, label: '80%' },
                                    { value: 0.90, label: '90%' },
                                    { value: 0.95, label: '95%' },
                                    { value: 1.00, label: '100%' },
                                ]}
                                valueLabelDisplay='auto'
                                valueLabelFormat={(v) => `${(v * 100).toFixed(0)}%`}
                            />
                        </Grid>

                        {/* Mode selector */}
                        <Grid item xs={12} sm={6}>
                            <TextField
                                select
                                fullWidth
                                label={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.mode.label',
                                    defaultMessage: 'Detection Mode',
                                })}
                                value={dedup.mode}
                                onChange={(e) => updateDedup('mode', e.target.value)}
                                variant='outlined'
                                size='small'
                                helperText={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.mode.helper',
                                    defaultMessage: 'How the system responds when duplicates are found',
                                })}
                            >
                                <MenuItem value='audit'>
                                    Audit - Log &amp; alert only
                                </MenuItem>
                                <MenuItem value='warn'>
                                    Warn - Log, alert &amp; add warning
                                </MenuItem>
                                <MenuItem value='block'>
                                    Block - Reject API creation
                                </MenuItem>
                            </TextField>
                        </Grid>

                        {/* Rule severity */}
                        <Grid item xs={12} sm={6}>
                            <TextField
                                select
                                fullWidth
                                label={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.severity.label',
                                    defaultMessage: 'Violation Severity',
                                })}
                                value={rule.severity || 'error'}
                                onChange={(e) => updateRule('severity', e.target.value)}
                                variant='outlined'
                                size='small'
                                helperText={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.severity.helper',
                                    defaultMessage: 'Severity level reported for detected duplicates',
                                })}
                            >
                                <MenuItem value='error'>Error</MenuItem>
                                <MenuItem value='warn'>Warning</MenuItem>
                                <MenuItem value='info'>Info</MenuItem>
                            </TextField>
                        </Grid>
                    </Grid>
                </AccordionDetails>
            </Accordion>

            {/* Algorithm Tuning */}
            <Accordion
                expanded={expanded === 'algorithm'}
                onChange={handleAccordionChange('algorithm')}
                variant='outlined'
                sx={{ mb: 1 }}
            >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <SpeedIcon fontSize='small' color='primary' />
                        <Typography variant='subtitle2'>
                            <FormattedMessage
                                id='Governance.Rulesets.GenericForm.algorithm.title'
                                defaultMessage='Algorithm Tuning (Advanced)'
                            />
                        </Typography>
                    </Box>
                </AccordionSummary>
                <AccordionDetails>
                    <Grid container spacing={3}>
                        {/* Hash Functions */}
                        <Grid item xs={12} sm={6}>
                            <Box sx={{
                                display: 'flex', alignItems: 'center', gap: 0.5, mb: 1,
                            }}
                            >
                                <Typography variant='body2' fontWeight='medium'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.hash.label'
                                        defaultMessage='Hash Functions'
                                    />
                                </Typography>
                                <Tooltip title={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.hash.tooltip',
                                    defaultMessage: 'Number of MinHash permutations. More = higher accuracy'
                                        + ' but more memory. Must be divisible by number of bands.',
                                })}
                                >
                                    <InfoOutlinedIcon fontSize='small' color='action' />
                                </Tooltip>
                                <Chip
                                    label={dedup.num_hash_functions}
                                    size='small'
                                    variant='outlined'
                                    sx={{ ml: 'auto' }}
                                />
                            </Box>
                            <Slider
                                value={dedup.num_hash_functions}
                                onChange={(e, val) => updateDedup('num_hash_functions', val)}
                                min={64}
                                max={512}
                                step={null}
                                marks={[
                                    { value: 64, label: '64' },
                                    { value: 128, label: '128' },
                                    { value: 256, label: '256' },
                                    { value: 512, label: '512' },
                                ]}
                            />
                        </Grid>

                        {/* Bands */}
                        <Grid item xs={12} sm={6}>
                            <Box sx={{
                                display: 'flex', alignItems: 'center', gap: 0.5, mb: 1,
                            }}
                            >
                                <Typography variant='body2' fontWeight='medium'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.bands.label'
                                        defaultMessage='LSH Bands'
                                    />
                                </Typography>
                                <Tooltip title={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.bands.tooltip',
                                    defaultMessage: 'Number of LSH bands. More bands = higher recall'
                                        + ' (finds more candidates). Must divide hash functions evenly.',
                                })}
                                >
                                    <InfoOutlinedIcon fontSize='small' color='action' />
                                </Tooltip>
                                <Chip
                                    label={dedup.num_bands}
                                    size='small'
                                    variant='outlined'
                                    sx={{ ml: 'auto' }}
                                />
                            </Box>
                            <Slider
                                value={dedup.num_bands}
                                onChange={(e, val) => updateDedup('num_bands', val)}
                                min={4}
                                max={64}
                                step={null}
                                marks={[
                                    { value: 4, label: '4' },
                                    { value: 8, label: '8' },
                                    { value: 16, label: '16' },
                                    { value: 32, label: '32' },
                                    { value: 64, label: '64' },
                                ]}
                            />
                        </Grid>

                        {/* Shingle Size */}
                        <Grid item xs={12} sm={6}>
                            <Box sx={{
                                display: 'flex', alignItems: 'center', gap: 0.5, mb: 1,
                            }}
                            >
                                <Typography variant='body2' fontWeight='medium'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.shingle.label'
                                        defaultMessage='Shingle Size (N-gram)'
                                    />
                                </Typography>
                                <Tooltip title={intl.formatMessage({
                                    id: 'Governance.Rulesets.GenericForm.shingle.tooltip',
                                    defaultMessage: 'Size of character n-grams for shingling. Larger values'
                                        + ' capture more context but may miss small variations.',
                                })}
                                >
                                    <InfoOutlinedIcon fontSize='small' color='action' />
                                </Tooltip>
                                <Chip
                                    label={dedup.shingle_size}
                                    size='small'
                                    variant='outlined'
                                    sx={{ ml: 'auto' }}
                                />
                            </Box>
                            <Slider
                                value={dedup.shingle_size}
                                onChange={(e, val) => updateDedup('shingle_size', val)}
                                min={2}
                                max={7}
                                step={1}
                                marks={[
                                    { value: 2, label: '2' },
                                    { value: 3, label: '3' },
                                    { value: 5, label: '5' },
                                    { value: 7, label: '7' },
                                ]}
                            />
                        </Grid>

                        {/* LSH Detection Probability Info */}
                        <Grid item xs={12} sm={6}>
                            <Box sx={{
                                p: 2,
                                bgcolor: 'info.lighter',
                                borderRadius: 1,
                                border: '1px solid',
                                borderColor: 'info.light',
                            }}
                            >
                                <Typography variant='body2' color='info.dark' fontWeight='medium'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.lsh.probability'
                                        defaultMessage='LSH Detection Probability'
                                    />
                                </Typography>
                                <Typography variant='h5' color='info.dark' sx={{ mt: 0.5 }}>
                                    {computeLSHProbability()}
                                    %
                                </Typography>
                                <Typography variant='caption' color='text.secondary'>
                                    <FormattedMessage
                                        id='Governance.Rulesets.GenericForm.lsh.probability.desc'
                                        defaultMessage='Probability that a pair at the similarity threshold
                                            will be detected as candidates'
                                    />
                                </Typography>
                            </Box>
                        </Grid>
                    </Grid>
                </AccordionDetails>
            </Accordion>

            {/* Rule Message */}
            <Accordion
                expanded={expanded === 'message'}
                onChange={handleAccordionChange('message')}
                variant='outlined'
            >
                <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography variant='subtitle2'>
                        <FormattedMessage
                            id='Governance.Rulesets.GenericForm.message.title'
                            defaultMessage='Violation Message'
                        />
                    </Typography>
                </AccordionSummary>
                <AccordionDetails>
                    <TextField
                        fullWidth
                        multiline
                        rows={3}
                        value={rule.message || ''}
                        onChange={(e) => updateRule('message', e.target.value)}
                        label={intl.formatMessage({
                            id: 'Governance.Rulesets.GenericForm.message.label',
                            defaultMessage: 'Message shown when a duplicate is detected',
                        })}
                        variant='outlined'
                        size='small'
                    />
                    <TextField
                        fullWidth
                        value={rule.description || ''}
                        onChange={(e) => updateRule('description', e.target.value)}
                        label={intl.formatMessage({
                            id: 'Governance.Rulesets.GenericForm.ruledesc.label',
                            defaultMessage: 'Rule Description',
                        })}
                        variant='outlined'
                        size='small'
                        sx={{ mt: 2 }}
                    />
                </AccordionDetails>
            </Accordion>
        </Box>
    );
}

GenericRulesetForm.propTypes = {
    rulesetContent: PropTypes.string.isRequired,
    onContentChange: PropTypes.func.isRequired,
};

export default GenericRulesetForm;
